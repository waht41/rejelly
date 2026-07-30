import path from "node:path";
import type { Message } from "@rejelly/core";
import { getUserInputDisplay } from "../../shared/attachments/messageContent";
import { isCompactionBridgeMessage } from "../../shared/lib/compactionMessages";
import {
  isKnownSessionEvent,
  type SessionEvent,
  type SessionMetaLine,
  type SessionStateEvent,
  type SessionStatus,
} from "./sessionEvents";
import type { SessionBudget } from "./sessionStore";
import { messageContentToText } from "./sessionStore";

const TITLE_MAX = 80;

export interface SessionSummary {
  id: string;
  workspaceRoot: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  userTurns: number;
  traceIds: string[];
  budget?: SessionBudget;
  status: SessionStatus;
  lastSeq: number;
}

export interface SessionFileStat {
  mtimeMs: number;
}

function titleFromMessage(message: Message): string | undefined {
  if (message.role !== "user" || isCompactionBridgeMessage(message)) {
    return undefined;
  }
  const raw = getUserInputDisplay(message)?.text ?? messageContentToText(message.content);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return undefined;
  }
  return oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX - 1)}…` : oneLine;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function projectSessionSummary(
  meta: SessionMetaLine,
  events: SessionEvent[],
  fileStat?: SessionFileStat,
): SessionSummary {
  let title = "(untitled)";
  let userTurns = 0;
  let budget: SessionBudget | undefined;
  let status: SessionStatus = "idle";
  let lastSeq = 0;
  const traceIds: string[] = [];
  const userTurnIds = new Set<string>();

  for (const event of events) {
    lastSeq = event.seq;
    if (!isKnownSessionEvent(event)) {
      continue;
    }
    switch (event.type) {
      case "legacy_snapshot": {
        title = event.legacyMeta.title || title;
        userTurns = event.legacyMeta.turns;
        budget = event.legacyMeta.budget;
        traceIds.push(...event.legacyMeta.traceIds);
        break;
      }
      case "run_segment_started":
        traceIds.push(event.traceId);
        status = "active";
        break;
      case "run_segment_ended":
        status =
          event.status === "completed"
            ? "idle"
            : event.status === "error"
              ? "error"
              : "interrupted";
        break;
      case "message_recorded":
        if (
          event.source.kind === "user_input" &&
          event.source.inputKind === "initial" &&
          !userTurnIds.has(event.turnId)
        ) {
          userTurnIds.add(event.turnId);
          userTurns += 1;
          title = title === "(untitled)" ? (titleFromMessage(event.message) ?? title) : title;
        }
        break;
      case "turn_completed":
        if (event.status === "error") {
          status = "error";
        } else if (event.status === "interrupted") {
          status = "interrupted";
        }
        break;
      case "context_compacted":
        // Active-context boundary only; it does not change picker/summary metadata.
        break;
      case "budget_updated":
        budget = event.budget;
        break;
      case "session_state":
        if (event.coveredThroughSeq !== event.seq - 1) {
          break;
        }
        title = event.title || title;
        userTurns = event.userTurns;
        budget = event.budget ?? budget;
        status = event.status;
        traceIds.splice(0, traceIds.length, ...event.traceIds);
        break;
      default:
        break;
    }
  }

  return {
    id: meta.sessionId,
    workspaceRoot: path.resolve(meta.workspaceRoot),
    title,
    createdAt: meta.createdAt,
    updatedAt: fileStat?.mtimeMs ?? events.at(-1)?.timestamp ?? meta.createdAt,
    userTurns,
    traceIds: unique(traceIds),
    budget,
    status,
    lastSeq,
  };
}

/** Fast-path summary when a validated tail checkpoint is available. */
export function projectSessionSummaryFromState(
  meta: SessionMetaLine,
  state: SessionStateEvent,
  fileStat?: SessionFileStat,
): SessionSummary {
  return {
    id: meta.sessionId,
    workspaceRoot: path.resolve(meta.workspaceRoot),
    title: state.title || "(untitled)",
    createdAt: meta.createdAt,
    updatedAt: fileStat?.mtimeMs ?? state.timestamp,
    userTurns: state.userTurns,
    traceIds: unique(state.traceIds),
    budget: state.budget,
    status: state.status,
    lastSeq: state.seq,
  };
}
