/**
 * Session agent: runs the selected top-level mode and owns the interactive loop for chat modes.
 */

import {
  createAgent,
  equipBudget,
  equipMemory,
  getUsageStats,
  isAbortError,
  type Message,
  reborn,
} from "@rejelly/core";
import { UnifiedAgent } from "../features/unified/UnifiedAgent";
import { getBinding, setBinding } from "../services/binding/hostBindings";
import {
  combineSessionBudget,
  formatSessionStatus,
  formatTokenUsageLine,
} from "../services/session/budgetStatus";
import { requestNewSession, requestResume } from "../services/session/resumeControl";
import {
  listSessions,
  loadSession,
  persistSession,
  type SessionBudget,
} from "../services/session/sessionStore";
import { withAbort } from "../services/stop/withAbort";
import {
  buildAttachmentActionSummary,
  buildUserMessageContent,
} from "../shared/attachments/messageContent";
import { env } from "../shared/config";
import { getWorkspaceFsPolicy } from "../shared/fs-policy/workspace-fs-policy";
import type { EvilJellyHostBindings } from "../shared/types";

const UnifiedAgentWithAbort = UnifiedAgent.fork({ middlewares: [withAbort()] });

/**
 * Handle a `/resume [sessionId]` command. Resolves the target (by id, or via an Ink-native
 * picker through host.requestChoice) and queues it for the outer loop.
 * Returns true when the run should end so the outer loop can switch sessions.
 */
async function tryRequestResume(rawInput: string, host: EvilJellyHostBindings): Promise<boolean> {
  const arg = rawInput.slice("/resume".length).trim();
  const workspaceRoot = getWorkspaceFsPolicy().getRoot();

  if (arg) {
    if (!loadSession(workspaceRoot, arg)) {
      host.logSystemEvent(`No saved session "${arg}" for this workspace.\n`);
      return false;
    }
    host.logSystemEvent(`Switching to session ${arg}…\n`);
    requestResume(arg);
    return true;
  }

  const sessions = listSessions(workspaceRoot);
  if (sessions.length === 0) {
    host.logSystemEvent("No saved sessions for this workspace.\n");
    return false;
  }
  const options = sessions.map((s, i) => ({
    key: i < 9 ? String(i + 1) : "",
    label: `${new Date(s.updatedAt).toLocaleString()}  (${s.turns} turns)  ${s.title}`,
    value: s.id,
  }));
  options.push({ key: "x", label: "Cancel", value: "" });
  const chosen = await host.requestChoice("Resume which session?", options);
  if (!chosen) {
    host.logSystemEvent("Resume cancelled.\n");
    return false;
  }
  host.logSystemEvent(`Switching to session ${chosen}…\n`);
  requestResume(chosen);
  return true;
}

export interface MainCliAgentProps extends EvilJellyHostBindings {
  /** Durable session id; when set, each completed turn is persisted locally for resume. */
  sessionId?: string;
  /** Current run segment traceId, recorded in the session's trace chain. */
  traceId?: string;
  /** Restored conversation seeded as the initial message_history on resume. */
  seedHistory?: Message[];
  /** Cumulative usage carried back from a resumed session, used as the /status base. */
  seedBudget?: SessionBudget;
  /** Replay-only mode: do not read from or write to durable local sessions. */
  isolateSessionState?: boolean;
}

function isExitCommand(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "/exit" || normalized === "exit";
}

export const MainCliAgent = createAgent<MainCliAgentProps, void>({
  id: "evil_jelly_cli_router",
  handler: async (props) => {
    // Store host bindings in the current agent context(by equipResource), then read the normalized host API.
    await setBinding(props);
    const host = getBinding();
    const [history, setHistory] = equipMemory<Message[]>(
      "message_history",
      props.seedHistory ?? [],
    );
    // Approx live context-window size: the most recent model call's input tokens (and its cached
    // subset). Kept in memory so they survive reborn (each turn re-runs this handler); seeded from
    // the resumed session.
    const [storedContextTokens, setLastContextTokens] = equipMemory<number>(
      "main_cli:last_context_tokens",
      props.seedBudget?.lastContextTokens ?? 0,
    );
    const [storedCacheTokens, setLastCacheTokens] = equipMemory<number>(
      "main_cli:last_cache_tokens",
      props.seedBudget?.lastCacheReadTokens ?? 0,
    );
    // Local mirrors initialized from the carried values and updated live during the turn (the
    // equipMemory getters are frozen at entry, so we mirror writes here for same-turn reads).
    let liveContextTokens = storedContextTokens;
    let liveCacheTokens = storedCacheTokens;
    // Root-context budget config fires for every model call in descendant agents (the update walks
    // the parent chain), so delta.promptTokens of the latest call tracks current context occupancy.
    equipBudget({
      onUpdate: ({ delta }) => {
        if (delta.promptTokens > 0) {
          liveContextTokens = delta.promptTokens;
          setLastContextTokens(delta.promptTokens);
          // cacheRead is the cached subset of this same call's input; 0 when the provider omits it.
          liveCacheTokens = delta.details?.cacheReadTokens ?? 0;
          setLastCacheTokens(liveCacheTokens);
        }
      },
    });

    // Cumulative session usage = resumed base + this run's aggregate (self + all sub-agents).
    const currentBudget = (): SessionBudget =>
      combineSessionBudget(props.seedBudget, getUsageStats().aggregate, {
        contextTokens: liveContextTokens,
        cacheReadTokens: liveCacheTokens,
      });

    // Persist boundary is the completed turn (after appendTurn), not sub-agent completion:
    // a turn is the atomic resumable point and sub-agents finish many times per turn.
    const persistTurn = (messages: Message[]) => {
      if (!props.sessionId) {
        return;
      }
      persistSession({
        workspaceRoot: getWorkspaceFsPolicy().getRoot(),
        sessionId: props.sessionId,
        traceId: props.traceId,
        messages,
        budget: currentBudget(),
      });
    };

    const appendTurn = (userContent: Message["content"], reply: string, delta?: Message[]) => {
      const assistantDelta =
        delta && delta.length > 0 ? delta : [{ role: "assistant" as const, content: reply }];
      const next = [...history, { role: "user" as const, content: userContent }, ...assistantDelta];
      setHistory(next);
      persistTurn(next);
    };

    let userInput = "";
    try {
      const lineInput = await host.getInput();
      userInput = lineInput.text.trim();

      if (isExitCommand(userInput)) {
        host.logSystemEvent("Goodbye.\n");
        return;
      }

      if (!userInput) {
        host.onStatusUpdate?.("Ready");
        return reborn();
      }

      if (userInput.toLowerCase() === "/clear") {
        const previousBudget = currentBudget();
        host.clearHistory?.();
        host.clearScreen?.();
        host.showSessionBanner?.();
        const summary = [formatTokenUsageLine(previousBudget)];
        // Only offer resume when a turn was persisted; an untouched session has no file on disk.
        if (props.sessionId && history.length > 0) {
          summary.push(`To continue the previous session, run /resume ${props.sessionId}`);
        }
        host.logSystemEvent(`${summary.join("\n")}\n`);
        requestNewSession();
        return;
      }

      if (userInput.toLowerCase() === "/status") {
        host.logSystemEvent(
          formatSessionStatus({
            sessionId: props.sessionId ?? "(ephemeral)",
            workspace: getWorkspaceFsPolicy().getRoot(),
            turns: history.filter((m) => m.role === "user").length,
            budget: currentBudget(),
            modelId: env.OPENAI_MODEL_ID,
            contextWindow: env.OPENAI_CONTEXT_WINDOW,
          }),
        );
        return reborn();
      }

      if (userInput.toLowerCase() === "/compress") {
        if (history.length === 0) {
          host.logSystemEvent("Nothing to compress yet.\n");
          return reborn();
        }
        host.logSystemEvent("Compressing session history…\n");
        const result = await UnifiedAgentWithAbort({
          userInput: "Compress the current session history.",
          history,
          operation: "compress",
        });
        if (result.compactHistory) {
          setHistory(result.compactHistory);
          persistTurn(result.compactHistory);
          host.logSystemEvent(
            `Session compressed: ${history.length} messages → ${result.compactHistory.length} messages.\n`,
          );
          return reborn();
        }
        host.logSystemEvent(`${result.reply || "Compression failed."}\n`);
        return reborn();
      }

      if (userInput.toLowerCase() === "/resume" || userInput.toLowerCase().startsWith("/resume ")) {
        if (props.isolateSessionState) {
          host.logSystemEvent("Resume is disabled during mock replay.\n");
          return reborn();
        }
        // End the run (no reborn) so this run's trace closes; outer loop starts the new segment.
        if (await tryRequestResume(userInput, host)) {
          return;
        }
        return reborn();
      }

      const attachmentActions = await buildAttachmentActionSummary(lineInput.attachments);
      const displayUserInput =
        attachmentActions.length > 0
          ? `${userInput}\n${attachmentActions.map((action) => `  -> ${action}`).join("\n")}`
          : userInput;
      host.logUserMessage(displayUserInput);

      const result = await UnifiedAgentWithAbort({
        userInput,
        attachments: lineInput.attachments,
        history,
      });

      if (result.compactHistory) {
        // Mid-loop auto-compaction (or /compress) already produced the full replacement history,
        // including this turn's user message and reply. Replace rather than append, otherwise the
        // pre-compaction bulk re-inflates on the next turn.
        setHistory(result.compactHistory);
        persistTurn(result.compactHistory);
      } else {
        const historyUserContent = await buildUserMessageContent({
          userInput,
          attachments: lineInput.attachments,
        });
        appendTurn(historyUserContent, result.reply, result.delta);
      }
      host.logAssistantMessage(result.reply);
    } catch (error) {
      if (isAbortError(error)) {
        // Abort while idle at the prompt makes getInput() throw before any real input exists.
        // That is not a conversation turn — recording a placeholder user message would pollute
        // history (and resume replay) with empty "N/A" / "interrupted" pairs. Only persist an
        // aborted turn when the user actually submitted something.
        if (userInput) {
          const abortedReply = "Task has been interrupted by user.";
          appendTurn(userInput, abortedReply);
          host.logAssistantMessage(abortedReply);
        }
        host.logSystemEvent("\n[System] Current task aborted. Returning to router.\n");
        return reborn();
      }
      throw error;
    }
    return reborn();
  },
});
