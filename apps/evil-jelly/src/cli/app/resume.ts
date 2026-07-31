import { createInterface } from "node:readline/promises";
import type { Message } from "@rejelly/core";
import {
  buildLegacyTranscript,
  type TranscriptItem,
} from "../../services/session/sessionHistoryProjection";
import {
  generateSessionId,
  listSessions,
  loadSession,
  type SessionBudget,
  type SessionRecord,
} from "../../services/session/sessionStore";
import { getWorkspaceFsPolicy } from "../../shared/fs-policy/workspace-fs-policy";
import { countConversationTurns } from "../../shared/lib/compactionMessages";
import type { EvilJellyHostBindings } from "../../shared/types";

export interface SessionResumeSeed {
  activeContext: Message[];
  transcript: TranscriptItem[];
  totalTurns: number;
  budget: SessionBudget | undefined;
}

/**
 * Resolve which saved session (if any) to resume. With an explicit id, loads it (exit if missing).
 * Without an id, prints a numbered list and prompts. Returns undefined to start a fresh session
 * (no sessions, or the user cancelled the picker). Runs before Ink so the prompt has the terminal.
 */
async function resolveResumeSession(
  workspaceRoot: string,
  sessionId: string | undefined,
): Promise<SessionRecord | undefined> {
  if (sessionId) {
    const record = loadSession(workspaceRoot, sessionId);
    if (!record) {
      console.error(`--resume: no saved session "${sessionId}" for this workspace.`);
      process.exit(1);
    }
    return record;
  }
  const sessions = listSessions(workspaceRoot);
  if (sessions.length === 0) {
    console.log("No saved sessions for this workspace. Starting a new session.");
    return undefined;
  }
  const shown = sessions.slice(0, 20);
  console.log("Recent sessions:");
  shown.forEach((s, i) => {
    console.log(
      `  [${i + 1}] ${new Date(s.updatedAt).toLocaleString()}  (${s.turns} turns)  ${s.title}`,
    );
  });
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = (await readline.question("Resume which? (number, empty to cancel): ")).trim();
  } finally {
    readline.close();
  }
  if (!answer) {
    return undefined;
  }
  const idx = Number.parseInt(answer, 10);
  if (Number.isNaN(idx) || idx < 1 || idx > shown.length) {
    console.error(`Invalid selection "${answer}". Starting a new session.`);
    return undefined;
  }
  return loadSession(workspaceRoot, shown[idx - 1]!.id);
}

function previewOf(text: string, maxLines = 6, maxChars = 600): string {
  const lines = text.split("\n").slice(0, maxLines).join("\n").slice(0, maxChars);
  return lines.length < text.length ? `${lines}\n...` : lines;
}

function toolSummary(toolName: string, args: string | undefined): string {
  const trimmedArgs = args?.trim();
  if (!trimmedArgs) {
    return `[Tools] ${toolName} (resumed)`;
  }
  const compactArgs = trimmedArgs.replace(/\s+/g, " ");
  const suffix = compactArgs.length > 120 ? `${compactArgs.slice(0, 117)}...` : compactArgs;
  return `[Tools] ${toolName} ${suffix} (resumed)`;
}

/** Convert one V1 snapshot into the context, display, count, and budget needed for resume. */
export function buildLegacyResumeSeed(
  messages: Message[],
  options: { totalTurns?: number; budget?: SessionBudget } = {},
): SessionResumeSeed {
  return {
    activeContext: messages,
    transcript: buildLegacyTranscript(messages, { tailTurns: 10 }),
    totalTurns: options.totalTurns ?? countConversationTurns(messages),
    budget: options.budget,
  };
}

/**
 * Replays a prepared transcript into the Ink history, then marks the resume boundary. The seed is
 * already storage-version agnostic; V1/V2 conversion belongs in their respective seed builders.
 */
export function hydrateResumeSeed(
  bindings: EvilJellyHostBindings,
  sessionId: string,
  seed: SessionResumeSeed,
): void {
  const { transcript } = seed;

  if (bindings.hydrateHistory) {
    bindings.hydrateHistory(transcript);
  } else {
    for (const item of transcript) {
      if (item.type === "user") {
        const actions = item.attachments?.map(
          (attachment) => `  -> ${attachment.action} ${attachment.label}`,
        );
        bindings.logUserMessage(
          actions?.length ? `${item.content}\n${actions.join("\n")}` : item.content,
        );
      } else if (item.type === "assistant") {
        bindings.logAssistantMessage(item.content);
      } else if (item.type === "system") {
        bindings.logSystemEvent(`${item.content}\n`);
      } else if (item.type === "tool") {
        const text = item.result ?? "";
        const toolName = item.toolName;
        bindings.logToolBlock({
          toolName,
          summary: toolSummary(toolName, item.arguments),
          preview: previewOf(text),
          fullResult: text,
          ok: item.ok,
        });
      }
    }
  }
  const visibleTurns = new Set(
    transcript
      .filter((item) => item.type === "user" && item.inputKind !== "steer")
      .map((item) => item.turnId),
  ).size;
  const priorTurns = seed.totalTurns;
  if (priorTurns > visibleTurns) {
    bindings.logSystemEvent(
      `Showing the last ${visibleTurns} of ${priorTurns} prior turns; earlier history remains saved ` +
        "in the session transcript.\n",
    );
  }
  bindings.logSystemEvent(`Resumed session ${sessionId} (${priorTurns} prior turns).\n`);
}

export interface InitialSessionState {
  sessionId: string;
  resumeSeed: SessionResumeSeed | undefined;
}

export async function resolveInitialSession(options: {
  resume: boolean;
  resumeSessionId: string | undefined;
}): Promise<InitialSessionState> {
  let sessionId = generateSessionId();
  let resumeSeed: SessionResumeSeed | undefined;

  if (options.resume) {
    const record = await resolveResumeSession(
      getWorkspaceFsPolicy().getRoot(),
      options.resumeSessionId,
    );
    if (record) {
      sessionId = record.meta.id;
      resumeSeed = buildLegacyResumeSeed(record.messages, {
        totalTurns: record.meta.turns,
        budget: record.meta.budget,
      });
    }
  }

  return { sessionId, resumeSeed };
}
