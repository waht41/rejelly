/**
 * Local session persistence for /resume.
 *
 * One file per session under ~/.evil-jelly/sessions/<workspace-bucket>/<sessionId>.json.
 * Stores only the top-level (router/Unified) conversation history plus light metadata;
 * sub-agent frames are ephemeral and intentionally not persisted. A logical session can span
 * several traceIds (one per launch/resume segment), recorded in meta.traceIds.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Message } from "@rejelly/core";
import { getUserInputDisplay } from "../../shared/attachments/messageContent";
import { resolveGlobalJellyDir } from "../../shared/globalPath";
import {
  countConversationTurns,
  isCompactionBridgeMessage,
  unwrapPriorUserMessageText,
} from "../../shared/lib/compactionMessages";

/**
 * Cumulative resource usage for a session, surviving across resume segments.
 * Tokens/cost are running sums; lastContextTokens is the most recent model call's input
 * tokens, used as an approximation of the live context-window occupancy (NOT a sum).
 */
export interface SessionBudget {
  /** prompt + completion across every model call in the session. */
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  /** Cumulative cached prompt tokens (a subset of promptTokens); 0 when the provider omits it. */
  cacheReadTokens: number;
  /** Number of model calls. */
  callCount: number;
  /** Aggregated cost by billing unit (e.g. micro_usd); integer amounts. */
  costs: Record<string, number>;
  /** Input tokens of the most recent model call ≈ current context-window usage. */
  lastContextTokens: number;
  /** Cached portion of the most recent call's input tokens (subset of lastContextTokens). */
  lastCacheReadTokens: number;
}

export interface SessionMeta {
  /** Durable session id (stable across resume; distinct from any single traceId). */
  id: string;
  /** Absolute workspace root the session belongs to. */
  workspaceRoot: string;
  /** First user line, truncated; used for the picker list. */
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Number of user turns recorded. */
  turns: number;
  /** Chain of run traceIds across launch/resume segments (for devtool回链). */
  traceIds: string[];
  /** Cumulative token/cost usage; carried back into the run on resume. */
  budget?: SessionBudget;
}

export interface SessionRecord {
  meta: SessionMeta;
  /** Top-level message_history (the Message[] MainCliAgent feeds back into the route handler). */
  messages: Message[];
}

const TITLE_MAX = 80;

/** ~/.evil-jelly/sessions */
function resolveSessionsRoot(): string {
  return path.join(resolveGlobalJellyDir(), "sessions");
}

/** Per-workspace bucket: <sanitized-basename>-<sha1(absRoot)[0..8]> so projects stay separate but readable. */
function workspaceBucket(workspaceRoot: string): string {
  const abs = path.resolve(workspaceRoot);
  const hash = crypto.createHash("sha1").update(abs).digest("hex").slice(0, 8);
  const base = path.basename(abs).replace(/[^\w.-]+/g, "_") || "workspace";
  return `${base}-${hash}`;
}

function resolveWorkspaceDir(workspaceRoot: string): string {
  return path.join(resolveSessionsRoot(), workspaceBucket(workspaceRoot));
}

function sessionFilePath(workspaceRoot: string, sessionId: string): string {
  return path.join(resolveWorkspaceDir(workspaceRoot), `${sessionId}.json`);
}

/** Sortable, human-ish session id: base36 timestamp + short random suffix. */
export function generateSessionId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

/** OTLP-compatible 32 hex chars, matching core's generateTraceId so devtool ingestion is unaffected. */
export function newTraceId(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function messageContentToText(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text: unknown }).text)
          : "",
      )
      .join(" ")
      .trim();
    return text;
  }
  return "";
}

function deriveTitle(messages: Message[]): string {
  const firstUser = messages.find(
    (message) => message.role === "user" && !isCompactionBridgeMessage(message),
  );
  const raw = firstUser
    ? (getUserInputDisplay(firstUser)?.text ??
      unwrapPriorUserMessageText(messageContentToText(firstUser.content)))
    : "";
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return "(untitled)";
  }
  return oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX - 1)}…` : oneLine;
}

function readRecord(filePath: string): SessionRecord | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as SessionRecord;
    if (!parsed || typeof parsed !== "object" || !parsed.meta || !Array.isArray(parsed.messages)) {
      return undefined;
    }
    return {
      ...parsed,
      meta: {
        ...parsed.meta,
        // Older V1 records counted the synthetic compaction bridge as a user turn.
        turns: countConversationTurns(parsed.messages),
      },
    };
  } catch {
    return undefined;
  }
}

export interface PersistSessionInput {
  workspaceRoot: string;
  sessionId: string;
  /** Current run's traceId; appended to the session's trace chain if new. */
  traceId?: string;
  messages: Message[];
  /** Cumulative usage snapshot for this session (replaces any prior value when provided). */
  budget?: SessionBudget;
}

/**
 * Best-effort persist of the top-level conversation. Merges with any existing record so
 * createdAt/title/traceIds stay stable across turns and resume segments. Never throws.
 */
export function persistSession(input: PersistSessionInput): void {
  try {
    const filePath = sessionFilePath(input.workspaceRoot, input.sessionId);
    const existing = readRecord(filePath);
    const now = Date.now();
    const traceIds = new Set(existing?.meta.traceIds ?? []);
    if (input.traceId) {
      traceIds.add(input.traceId);
    }
    const meta: SessionMeta = {
      id: input.sessionId,
      workspaceRoot: path.resolve(input.workspaceRoot),
      title: existing?.meta.title ?? deriveTitle(input.messages),
      createdAt: existing?.meta.createdAt ?? now,
      updatedAt: now,
      turns: countConversationTurns(input.messages),
      traceIds: [...traceIds],
      budget: input.budget ?? existing?.meta.budget,
    };
    const record: SessionRecord = { meta, messages: input.messages };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
  } catch {
    // Persistence is best-effort; a failed write must not break the turn.
  }
}

/** Sessions for the given workspace, newest first. Returns metadata only (cheap for the picker). */
export function listSessions(workspaceRoot: string): SessionMeta[] {
  const dir = resolveWorkspaceDir(workspaceRoot);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const metas: SessionMeta[] = [];
  for (const entry of entries) {
    const record = readRecord(path.join(dir, entry));
    if (record) {
      metas.push(record.meta);
    }
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Full record (meta + messages) for one session, or undefined if missing/corrupt. */
export function loadSession(workspaceRoot: string, sessionId: string): SessionRecord | undefined {
  return readRecord(sessionFilePath(workspaceRoot, sessionId));
}
