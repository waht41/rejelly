/**
 * CLI application orchestrator: routes interactive commands and coordinates agent/session turns.
 */

import { randomBytes } from "node:crypto";
import {
  createAgent,
  equipBudget,
  equipMemory,
  expectResource,
  getUsageStats,
  isAbortError,
  type Message,
  reborn,
} from "@rejelly/core";
import type { SessionRecorder } from "../../../domains/session/recorder/sessionRecorder";
import {
  listSessions,
  loadSession,
  type SessionBudget,
} from "../../../domains/session/repository/sessionStore";
import {
  SKILL_RUNTIME_PROVIDER_KEY,
  type SkillRuntimeSnapshot,
} from "../../../domains/skills/agent/skillRuntime";
import { UnifiedAgent } from "../../../features/unified/UnifiedAgent";
import { env } from "../../../shared/config";
import { countConversationTurns } from "../../../shared/conversation/compactionMessages";
import { getWorkspaceFsPolicy } from "../../../shared/fs-policy/workspace-fs-policy";
import type { EvilJellyBindings } from "../../../shared/host/bindings";
import { getBinding, setBinding } from "../../../shared/host/context";
import type { LineInputValue } from "../../../shared/host/inputBindings";
import { getUserInputDisplay } from "../../../shared/model/message/userInputMetadata";
import { requestNewSession, requestResume } from "../../runtime/sessionRunControl";
import { drainSteers } from "../../runtime/steerControl";
import { withAbort } from "../../runtime/withAbort";
import { buildSkillAwareUserMessage } from "../host/skillAwareUserMessage";
import { combineSessionBudget, formatSessionStatus, formatTokenUsageLine } from "./sessionStatus";
import { formatUserInputDisplay } from "./userInputDisplay";

const UnifiedAgentWithAbort = UnifiedAgent.fork({ middlewares: [withAbort()] });

/**
 * Handle a `/resume [sessionId]` command. Resolves the target (by id, or via an Ink-native
 * picker through host.requestChoice) and queues it for the outer loop.
 * Returns true when the run should end so the outer loop can switch sessions.
 */
export async function tryRequestResume(
  rawInput: string,
  currentSessionId: string | undefined,
  host: EvilJellyBindings,
): Promise<boolean> {
  const arg = rawInput.slice("/resume".length).trim();
  const workspaceRoot = getWorkspaceFsPolicy().getRoot();

  if (arg) {
    if (arg === currentSessionId) {
      host.logSystemEvent(`Session ${arg} is already current.\n`);
      return false;
    }
    if (!(await loadSession(workspaceRoot, arg))) {
      host.logSystemEvent(`No saved session "${arg}" for this workspace.\n`);
      return false;
    }
    host.logSystemEvent(`Switching to session ${arg}…\n`);
    requestResume(arg);
    return true;
  }

  const sessions = (await listSessions(workspaceRoot)).filter(
    (session) => session.id !== currentSessionId,
  );
  if (sessions.length === 0) {
    host.logSystemEvent("No other saved sessions for this workspace.\n");
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

export interface MainCliAgentProps extends EvilJellyBindings {
  /** Durable session id; when set, each completed turn is persisted locally for resume. */
  sessionId?: string;
  /** Current run segment traceId, recorded in the session's trace chain. */
  traceId?: string;
  /** Restored active model context seeded as message_history on resume. */
  seedContext?: Message[];
  /** Session image store consulted only when a model policy materializes durable locators. */
  sessionBlobRoot?: string;
  /** @deprecated Compatibility alias; new callers should pass seedContext. */
  seedHistory?: Message[];
  /** Cumulative usage carried back from a resumed session, used as the /status base. */
  seedBudget?: SessionBudget;
  /** Replay-only mode: do not read from or write to durable local sessions. */
  isolateSessionState?: boolean;
  /** Session V2 writer. Undefined only for ephemeral or isolated runs. */
  sessionRecorder?: SessionRecorder;
}

type RouterIntent =
  | { kind: "empty" }
  | { kind: "exit" }
  | { kind: "clear" }
  | { kind: "status" }
  | { kind: "compress" }
  | { kind: "resume"; rawInput: string }
  | { kind: "message"; lineInput: LineInputValue; userInput: string };

interface RouterRuntime {
  props: MainCliAgentProps;
  host: EvilJellyBindings;
  history: Message[];
  setHistory: (messages: Message[]) => void;
  currentBudget: () => SessionBudget;
  appendTurn: (userMessage: Message, reply: string, delta?: Message[]) => void;
  skillSnapshot?: SkillRuntimeSnapshot;
}

/** Short, session-local correlation ID with 96 bits of entropy and URL-safe characters. */
function createTurnId(): string {
  return randomBytes(12).toString("base64url");
}

function classifyRouterIntent(lineInput: LineInputValue): RouterIntent {
  const userInput = lineInput.text.trim();
  if (!userInput) {
    return { kind: "empty" };
  }
  const normalized = userInput.toLowerCase();
  if (normalized === "/exit" || normalized === "exit") {
    return { kind: "exit" };
  }
  if (normalized === "/clear") {
    return { kind: "clear" };
  }
  if (normalized === "/status") {
    return { kind: "status" };
  }
  if (normalized === "/compress") {
    return { kind: "compress" };
  }
  if (normalized === "/resume" || normalized.startsWith("/resume ")) {
    return { kind: "resume", rawInput: userInput };
  }
  return { kind: "message", lineInput, userInput };
}

async function handleExit(runtime: RouterRuntime): Promise<void> {
  await runtime.props.sessionRecorder?.endSegment({
    status: "completed",
    reason: "exit",
    budget: runtime.currentBudget(),
  });
  runtime.host.logSystemEvent("Goodbye.\n");
}

async function handleClear(runtime: RouterRuntime): Promise<void> {
  const previousBudget = runtime.currentBudget();
  runtime.host.clearHistory?.();
  runtime.host.clearScreen?.();
  runtime.host.showSessionBanner?.();
  const summary = [formatTokenUsageLine(previousBudget)];
  // Only offer resume when a turn was persisted; an untouched session has no file on disk.
  if (runtime.props.sessionId && runtime.history.length > 0) {
    summary.push(`To continue the previous session, run /resume ${runtime.props.sessionId}`);
  }
  runtime.host.logSystemEvent(`${summary.join("\n")}\n`);
  await runtime.props.sessionRecorder?.endSegment({
    status: "completed",
    reason: "new_session",
    budget: previousBudget,
  });
  requestNewSession();
}

function handleStatus(runtime: RouterRuntime): void {
  runtime.host.logSystemEvent(
    formatSessionStatus({
      sessionId: runtime.props.sessionId ?? "(ephemeral)",
      workspace: getWorkspaceFsPolicy().getRoot(),
      turns: countConversationTurns(runtime.history),
      budget: runtime.currentBudget(),
      modelId: env.OPENAI_MODEL_ID,
      contextWindow: env.OPENAI_CONTEXT_WINDOW,
    }),
  );
}

async function handleCompress(runtime: RouterRuntime): Promise<void> {
  if (runtime.history.length === 0) {
    runtime.host.logSystemEvent("Nothing to compress yet.\n");
    return;
  }
  runtime.host.logSystemEvent("Compressing session history…\n");
  const result = await UnifiedAgentWithAbort({
    history: runtime.history,
    operation: "compress",
    sessionBlobRoot: runtime.props.sessionBlobRoot,
  });
  if (!result.compactHistory) {
    runtime.host.logSystemEvent(`${result.reply || "Compression failed."}\n`);
    return;
  }

  runtime.setHistory(result.compactHistory);
  if (runtime.props.sessionRecorder) {
    await runtime.props.sessionRecorder.recordCompaction({
      trigger: "manual",
      replacementHistory: result.compactHistory,
      beforeMessageCount: runtime.history.length,
    });
  }
  runtime.host.logSystemEvent(
    `Session compressed: ${runtime.history.length} messages → ${result.compactHistory.length} messages.\n`,
  );
}

function displayPreparedUserMessage(message: Message, fallback: string): string {
  const display = getUserInputDisplay(message);
  return display ? formatUserInputDisplay(display) : fallback;
}

async function drainAndPrepareSteerMessages(runtime: RouterRuntime): Promise<Message[]> {
  const messages: Message[] = [];
  for (const input of drainSteers()) {
    const message = await buildSkillAwareUserMessage(input, runtime.skillSnapshot);
    runtime.host.logUserMessage(displayPreparedUserMessage(message, input.text));
    messages.push(message);
  }
  return messages;
}

async function handleResume(runtime: RouterRuntime, rawInput: string): Promise<boolean> {
  if (runtime.props.isolateSessionState) {
    runtime.host.logSystemEvent("Resume is disabled during mock replay.\n");
    return false;
  }
  if (!(await tryRequestResume(rawInput, runtime.props.sessionId, runtime.host))) {
    return false;
  }
  // End the run (no reborn) so this trace closes before the outer loop starts the target segment.
  await runtime.props.sessionRecorder?.endSegment({
    status: "completed",
    reason: "switch_session",
    budget: runtime.currentBudget(),
  });
  return true;
}

function formatPersistenceError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeTurnAfterFailure(
  runtime: RouterRuntime,
  turnId: string,
  status: "interrupted" | "error",
): Promise<void> {
  await runtime.props.sessionRecorder
    ?.completeTurn(turnId, status, runtime.currentBudget())
    .catch((error) =>
      runtime.host.logSystemEvent(
        `\nSession turn close failed: ${formatPersistenceError(error)}\n`,
      ),
    );
}

async function runConversationTurn(
  runtime: RouterRuntime,
  lineInput: LineInputValue,
  userInput: string,
): Promise<void> {
  let submittedUserMessage: Message | undefined;
  let activeTurnId: string | undefined;
  // Set before awaiting completeTurn: a partial append must not be retried as a second closure.
  let turnClosureAttempted = false;

  try {
    submittedUserMessage = await buildSkillAwareUserMessage(lineInput, runtime.skillSnapshot);
    runtime.host.logUserMessage(displayPreparedUserMessage(submittedUserMessage, userInput));
    activeTurnId = createTurnId();
    // The session layer marks the turn start here (inputKind: "initial"); the status line's
    // timer must anchor at exactly this point so steers and maintenance commands never
    // start (or restart) a turn.
    runtime.host.onTurnStart?.();
    await runtime.props.sessionRecorder?.recordMessage(
      activeTurnId,
      { kind: "user_input", inputKind: "initial" },
      submittedUserMessage,
    );

    const result = await UnifiedAgentWithAbort({
      message: submittedUserMessage,
      history: runtime.history,
      pendingUserMessages: () => drainAndPrepareSteerMessages(runtime),
      sessionBlobRoot: runtime.props.sessionBlobRoot,
      sessionRecorder: runtime.props.sessionRecorder,
      turnId: activeTurnId,
    });

    if (result.compactHistory) {
      // The auto-compact event already reset V2 active context. Keep the live memory aligned with
      // its replacement plus post-compact delta.
      runtime.setHistory(result.compactHistory);
    } else {
      runtime.appendTurn(submittedUserMessage, result.reply, result.delta);
    }

    if (runtime.props.sessionRecorder) {
      if (!result.interrupted && (!result.delta || result.delta.length === 0) && result.reply) {
        await runtime.props.sessionRecorder.recordMessage(
          activeTurnId,
          { kind: "agent_runtime" },
          { role: "assistant", content: result.reply },
        );
      }
      turnClosureAttempted = true;
      await runtime.props.sessionRecorder.completeTurn(
        activeTurnId,
        result.interrupted ? "interrupted" : "completed",
        runtime.currentBudget(),
      );
    }
    runtime.host.logAssistantMessage(result.reply);
  } catch (error) {
    if (isAbortError(error)) {
      const abortedReply = "Task has been interrupted by user.";
      if (runtime.props.sessionRecorder && activeTurnId) {
        if (!turnClosureAttempted) {
          await closeTurnAfterFailure(runtime, activeTurnId, "interrupted");
        }
      } else {
        runtime.appendTurn(
          submittedUserMessage ?? {
            role: "user",
            content: userInput,
          },
          abortedReply,
        );
      }
      runtime.host.logAssistantMessage(abortedReply);
      runtime.host.logSystemEvent("\n[System] Current task aborted. Returning to router.\n");
      return;
    }

    if (runtime.props.sessionRecorder && activeTurnId && !turnClosureAttempted) {
      await closeTurnAfterFailure(runtime, activeTurnId, "error");
    }
    throw error;
  }
}

export const MainCliAgent = createAgent<MainCliAgentProps, void>({
  id: "evil_jelly_cli_router",
  handler: async (props) => {
    // Store host bindings in the current agent context(by equipResource), then read the normalized host API.
    await setBinding(props);
    const host = getBinding();
    const [history, setHistory] = equipMemory<Message[]>(
      "message_history",
      props.seedContext ?? props.seedHistory ?? [],
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

    const appendTurn = (userMessage: Message, reply: string, delta?: Message[]) => {
      const assistantDelta =
        delta && delta.length > 0 ? delta : [{ role: "assistant" as const, content: reply }];
      const next = [...history, userMessage, ...assistantDelta];
      setHistory(next);
    };

    const runtime: RouterRuntime = {
      props,
      host,
      history,
      setHistory,
      currentBudget,
      appendTurn,
      skillSnapshot: expectResource<SkillRuntimeSnapshot>(SKILL_RUNTIME_PROVIDER_KEY, {
        optional: true,
      }),
    };

    try {
      const lineInput = await host.getInput();
      const intent = classifyRouterIntent(lineInput);
      switch (intent.kind) {
        case "empty":
          host.onDetailUpdate?.("Ready");
          host.onPhaseUpdate?.("idle");
          return reborn();
        case "exit":
          await handleExit(runtime);
          return;
        case "clear":
          await handleClear(runtime);
          return;
        case "status":
          handleStatus(runtime);
          return reborn();
        case "compress":
          await handleCompress(runtime);
          return reborn();
        case "resume":
          if (await handleResume(runtime, intent.rawInput)) {
            return;
          }
          return reborn();
        case "message":
          await runConversationTurn(runtime, intent.lineInput, intent.userInput);
          return reborn();
      }
    } catch (error) {
      if (isAbortError(error)) {
        // Only prompt/maintenance aborts reach the router. Real message turns own their interrupted
        // boundary inside runConversationTurn and therefore never create a placeholder idle turn.
        host.logSystemEvent("\n[System] Current task aborted. Returning to router.\n");
        return reborn();
      }
      throw error;
    }
  },
});
