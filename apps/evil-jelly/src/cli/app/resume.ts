import { createInterface } from "node:readline/promises";
import type { Message } from "@rejelly/core";
import {
  generateSessionId,
  listSessions,
  loadSession,
  messageContentToText,
  type SessionBudget,
  type SessionRecord,
} from "../../services/session/sessionStore";
import { getWorkspaceFsPolicy } from "../../shared/fs-policy/workspace-fs-policy";
import {
  countConversationTurns,
  isCompactionBridgeMessage,
  unwrapPriorUserMessageText,
} from "../../shared/lib/compactionMessages";
import type { EvilJellyHostBindings } from "../../shared/types";

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

/**
 * Persisted assistant turns store the model's structured response (`{type:"answer",reply:"..."}`),
 * but the live UI only ever shows the `reply` field. Mirror that here so replayed history reads
 * like the original conversation, not raw JSON. Falls back to the text for any other shape.
 */
function assistantDisplayText(text: string): string {
  try {
    const parsed = JSON.parse(text) as { reply?: unknown };
    if (parsed && typeof parsed.reply === "string") {
      return parsed.reply;
    }
  } catch {
    // Not JSON; render as-is.
  }
  return text;
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

/**
 * Replays a resumed session's prior turns into the Ink `<Static>` history so the user sees the
 * real conversation above the prompt, not just a one-line summary. User/assistant turns are
 * rendered as their own history items. Tool result messages are reconstructed into host tool
 * blocks from the preceding assistant tool_calls so the transcript overlay can browse them after
 * resume. A trailing system line marks the boundary between restored history and the new live
 * segment.
 */
export function seedHistoryIntoView(
  bindings: EvilJellyHostBindings,
  sessionId: string,
  seedHistory: Message[],
): void {
  const pendingToolCalls = new Map<string, { name: string; arguments?: string }>();

  for (const message of seedHistory) {
    if (isCompactionBridgeMessage(message)) {
      bindings.logSystemEvent("Context was compacted in a previous run.\n");
      continue;
    }

    if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        pendingToolCalls.set(call.id, { name: call.name, arguments: call.arguments });
      }
      continue;
    }

    const text = messageContentToText(message.content).trim();
    if (!text) {
      continue;
    }
    if (message.role === "user") {
      bindings.logUserMessage(unwrapPriorUserMessageText(text));
    } else if (message.role === "assistant") {
      bindings.logAssistantMessage(assistantDisplayText(text));
    } else if (message.role === "tool") {
      const call = message.tool_call_id ? pendingToolCalls.get(message.tool_call_id) : undefined;
      const toolName = call?.name ?? message.name ?? "tool";
      bindings.logToolBlock({
        toolName,
        summary: toolSummary(toolName, call?.arguments),
        preview: previewOf(text),
        fullResult: text,
        ok: true,
      });
    }
  }
  const priorTurns = countConversationTurns(seedHistory);
  bindings.logSystemEvent(`Resumed session ${sessionId} (${priorTurns} prior turns).\n`);
}

export interface InitialSessionState {
  sessionId: string;
  seedHistory: Message[] | undefined;
  seedBudget: SessionBudget | undefined;
}

export async function resolveInitialSession(options: {
  resume: boolean;
  resumeSessionId: string | undefined;
}): Promise<InitialSessionState> {
  let sessionId = generateSessionId();
  let seedHistory: Message[] | undefined;
  let seedBudget: SessionBudget | undefined;

  if (options.resume) {
    const record = await resolveResumeSession(
      getWorkspaceFsPolicy().getRoot(),
      options.resumeSessionId,
    );
    if (record) {
      sessionId = record.meta.id;
      seedHistory = record.messages;
      seedBudget = record.meta.budget;
    }
  }

  return { sessionId, seedHistory, seedBudget };
}
