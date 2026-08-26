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
import { createAuthorizedMcpBindingFactory } from "../../domains/mcp/management/chatAuthorization";
import type { McpSessionControl } from "../../domains/mcp/management/sessionControl";
import { memoryIdSchema } from "../../domains/memory/model/memorySchema";
import {
  MEMORY_RUNTIME_PROVIDER_KEY,
  type SessionMemoryRuntime,
} from "../../domains/memory/runtime/sessionMemoryRuntime";
import type { SessionRecorder } from "../../domains/session/recorder/sessionRecorder";
import {
  listSessions,
  loadSession,
  type SessionBudget,
} from "../../domains/session/repository/sessionStore";
import {
  commitResolvedUserInput,
  materializeFrozenUserInputMessage,
} from "../../domains/session/repository/userInputRepository";
import {
  SKILL_RUNTIME_PROVIDER_KEY,
  type SkillRuntimeSnapshot,
} from "../../domains/skills/agent/skillRuntime";
import type { ConversationAgentProps } from "../../features/unified/conversationRun";
import { UnifiedAgent } from "../../features/unified/UnifiedAgent";
import { env } from "../../shared/configuration/env";
import { countConversationTurns } from "../../shared/conversation/compactionMessages";
import { getWorkspaceFsPolicy } from "../../shared/fs-policy/workspace-fs-policy";
import type { EvilJellyBindings } from "../../shared/host/bindings";
import { getBinding, setBinding } from "../../shared/host/context";
import { releasePromptResources } from "../../shared/host/promptResourceLifecycle";
import {
  createSessionMcpState,
  type SessionMcpState,
} from "../../shared/model/mcp/sessionMcpState";
import {
  type FrozenUserInputV1,
  frozenUserInputMcpServerIds,
  projectFrozenUserInputDisplay,
  type ResolvedUserInputV1,
} from "../../shared/model/prompt/frozenUserInput";
import {
  isPromptInputSemanticallyEmpty,
  type PromptInput,
  promptInputCommandText,
  promptInputPlainText,
} from "../../shared/model/prompt/promptInput";
import { formatUserInputDisplay } from "../conversation-display/history/userInputDisplay";
import {
  formatSessionStatus,
  formatTokenUsageLine,
} from "../conversation-display/session-summary/format";
import { materializeSkillAwareUserInput } from "../message-composer/message-materialization/skillAwareUserMessage";
import { memoryReferenceName } from "../message-composer/suggestions/semantic-reference/referenceNaming";
import { withAbort } from "../runtime/withAbort";
import { drainSteers } from "../submission-dispatch/steerQueue";
import { combineSessionBudget } from "./budget";
import { handleMcpCommand, isMcpLocalCommand } from "./mcpCommands";
import { handleMemoryCommand, isMemoryLocalCommand } from "./memoryCommands";
import {
  handleSkillsCommand,
  isSkillsLocalCommand,
  type SkillDoctorReport,
} from "./skillsCommands";

const UnifiedAgentWithAbort = UnifiedAgent.fork({ middlewares: [withAbort()] });

export type ConversationLoopIntent =
  | { type: "exit" }
  | { type: "new_session" }
  | { type: "resume"; sessionId: string };

export interface ConversationLoopControl {
  request: (intent: ConversationLoopIntent) => void;
}

/**
 * Handle a `/resume [sessionId]` command. Resolves the target (by id, or via an Ink-native
 * picker through host.requestChoice) and queues it for the outer loop.
 * Returns true when the run should end so the outer loop can switch sessions.
 */
export async function tryRequestResume(
  rawInput: string,
  currentSessionId: string | undefined,
  host: EvilJellyBindings,
  runLoopControl: ConversationLoopControl,
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
    runLoopControl.request({ type: "resume", sessionId: arg });
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
  const chosen = await host.requestChoice({
    message: "Resume which session?",
    options,
    cancelValue: "",
  });
  if (!chosen) {
    host.logSystemEvent("Resume cancelled.\n");
    return false;
  }
  host.logSystemEvent(`Switching to session ${chosen}…\n`);
  runLoopControl.request({ type: "resume", sessionId: chosen });
  return true;
}

export interface MainCliAgentProps extends EvilJellyBindings {
  runLoopControl: ConversationLoopControl;
  /** Durable session id; when set, each completed turn is persisted locally for resume. */
  sessionId?: string;
  /** Current run segment traceId, recorded in the session's trace chain. */
  traceId?: string;
  /** Restored active model context seeded as message_history on resume. */
  seedContext?: Message[];
  /** Session image store consulted only when a model policy materializes durable locators. */
  sessionBlobRoot?: string;
  /** Cumulative usage carried back from a resumed session, used as the /status base. */
  seedBudget?: SessionBudget;
  /** Session-level MCP authorization state recovered from its V3 projection. */
  seedMcpState?: SessionMcpState;
  resolveMcpUserInput?: (serverId: string) => {
    status: "selected" | "unavailable" | "disabled" | "untrusted";
    configFingerprint?: string;
  };
  /** Replay-only mode: do not read from or write to durable local sessions. */
  isolateSessionState?: boolean;
  /** Session V3 writer. Undefined only for ephemeral or isolated runs. */
  sessionRecorder?: SessionRecorder;
  /** Composition-root factory for immutable per-model-dispatch MCP bindings. */
  mcpBindingFactory?: ConversationAgentProps["mcpBindingFactory"];
  /** Interactive status/reload/trust operations over the process-owned MCP runtime. */
  mcpSessionControl?: McpSessionControl;
  /** Fresh read-only Skill scan for the local `/skills doctor` command. */
  diagnoseSkills?: () => Promise<SkillDoctorReport>;
}

type RouterIntent =
  | { kind: "empty" }
  | { kind: "exit" }
  | { kind: "clear" }
  | { kind: "status" }
  | { kind: "compress" }
  | { kind: "resume"; rawInput: string }
  | { kind: "mcp"; rawInput: string }
  | { kind: "memory"; rawInput: string }
  | { kind: "skills"; rawInput: string }
  | { kind: "message"; promptInput: PromptInput; userInput: string };

interface RouterRuntime {
  props: MainCliAgentProps;
  host: EvilJellyBindings;
  history: Message[];
  setHistory: (messages: Message[]) => void;
  currentBudget: () => SessionBudget;
  appendTurn: (userMessage: Message, reply: string, delta?: Message[]) => void;
  skillSnapshot?: SkillRuntimeSnapshot;
  resolveMcpUserInput?: MainCliAgentProps["resolveMcpUserInput"];
  sessionMcpState: () => SessionMcpState;
  setSessionMcpState: (state: SessionMcpState) => void;
  nextImageOrdinal: () => number;
  setNextImageOrdinal: (ordinal: number) => void;
  mcpBindingFactory?: ConversationAgentProps["mcpBindingFactory"];
  memoryRuntime?: SessionMemoryRuntime;
}

/** Short, session-local correlation ID with 96 bits of entropy and URL-safe characters. */
function createTurnId(): string {
  return randomBytes(12).toString("base64url");
}

function classifyRouterIntent(promptInput: PromptInput): RouterIntent {
  if (isPromptInputSemanticallyEmpty(promptInput)) {
    return { kind: "empty" };
  }
  const commandText = promptInputCommandText(promptInput)?.trim();
  const normalized = commandText?.toLowerCase();
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
  if (normalized === "/resume" || normalized?.startsWith("/resume ")) {
    return { kind: "resume", rawInput: commandText! };
  }
  if (commandText && isMemoryLocalCommand(commandText)) {
    return { kind: "memory", rawInput: commandText };
  }
  if (commandText && isMcpLocalCommand(commandText)) {
    return { kind: "mcp", rawInput: commandText };
  }
  if (commandText && isSkillsLocalCommand(commandText)) {
    return { kind: "skills", rawInput: commandText };
  }
  return { kind: "message", promptInput, userInput: promptInputPlainText(promptInput).trim() };
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
  runtime.props.runLoopControl.request({ type: "new_session" });
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

async function drainAndPrepareSteerMessages(
  runtime: RouterRuntime,
  turnId: string,
  turnMcpSelection: Set<string>,
): Promise<Message[]> {
  const messages: Message[] = [];
  const inputs = drainSteers();
  try {
    for (const input of inputs) {
      const resolved = await materializePromptInput(runtime, input).finally(() =>
        releasePromptResources(input).catch((error) =>
          runtime.host.logSystemEvent(
            `Prompt resource cleanup failed: ${formatPersistenceError(error)}\n`,
          ),
        ),
      );
      const committed = await commitUserInput(runtime, turnId, "steer", resolved);
      for (const serverId of frozenUserInputMcpServerIds(committed.frozen)) {
        turnMcpSelection.add(serverId);
      }
      messages.push(committed.message);
    }
  } catch (error) {
    await Promise.all(inputs.map((input) => releasePromptResources(input).catch(() => undefined)));
    throw error;
  }
  return messages;
}

function materializePromptInput(
  runtime: RouterRuntime,
  input: PromptInput,
): Promise<ResolvedUserInputV1> {
  return materializeSkillAwareUserInput(input, runtime.skillSnapshot, {
    mcpResolution: (serverId) => {
      return {
        ...(runtime.resolveMcpUserInput?.(serverId) ?? { status: "unavailable" as const }),
        referenceName: serverId,
      };
    },
    memoryResolution: async (memoryId) => {
      if (!runtime.memoryRuntime || !memoryIdSchema.safeParse(memoryId).success) {
        return { status: "unavailable" };
      }
      try {
        const result = await runtime.memoryRuntime.service.list({
          scope: "all",
          ids: [memoryId],
          view: "detail",
        });
        const entry = result.entries[0];
        return entry
          ? {
              status: "resolved",
              scope: entry.scope,
              revision: entry.revision,
              title: entry.title,
              summary: entry.summary,
              detail: entry.detail,
              referenceName: memoryReferenceName(
                { memoryId: entry.id },
                runtime.memoryRuntime.epoch.entries,
              ),
            }
          : { status: "unavailable" };
      } catch {
        return { status: "unavailable" };
      }
    },
  });
}

async function commitUserInput(
  runtime: RouterRuntime,
  turnId: string,
  inputKind: "initial" | "steer",
  resolved: ResolvedUserInputV1,
): Promise<{ readonly frozen: FrozenUserInputV1; readonly message: Message }> {
  const frozen = runtime.props.sessionRecorder
    ? await runtime.props.sessionRecorder.recordUserInput(turnId, inputKind, resolved)
    : await commitResolvedUserInput(resolved, {
        blobRoot: runtime.props.sessionBlobRoot,
        imageOrdinalStart: runtime.nextImageOrdinal(),
      });
  const nextImageOrdinal = runtime.props.sessionRecorder
    ? runtime.props.sessionRecorder.nextImageOrdinal
    : runtime.nextImageOrdinal() +
      (frozen.kind === "resolved"
        ? frozen.nodes.filter((node) => node.kind === "image").length
        : 0);
  runtime.setNextImageOrdinal(nextImageOrdinal);
  runtime.host.logUserMessage(formatUserInputDisplay(projectFrozenUserInputDisplay(frozen)));
  return {
    frozen,
    message: await materializeFrozenUserInputMessage(frozen, {
      blobRoot: runtime.props.sessionBlobRoot,
    }),
  };
}

async function handleResume(runtime: RouterRuntime, rawInput: string): Promise<boolean> {
  if (runtime.props.isolateSessionState) {
    runtime.host.logSystemEvent("Resume is disabled during mock replay.\n");
    return false;
  }
  if (
    !(await tryRequestResume(
      rawInput,
      runtime.props.sessionId,
      runtime.host,
      runtime.props.runLoopControl,
    ))
  ) {
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

async function handleMemory(runtime: RouterRuntime, rawInput: string): Promise<void> {
  const memoryRuntime = runtime.memoryRuntime;
  if (!memoryRuntime) {
    runtime.host.logSystemEvent("Persistent memory is unavailable in this runtime.\n");
    return;
  }
  await handleMemoryCommand(rawInput, {
    service: memoryRuntime.service,
    runtime: memoryRuntime,
    sessionId: runtime.props.sessionId,
    requestConfirmation: runtime.host.requestMemoryConfirmation,
    requestMemoryManager: runtime.host.requestMemoryManager,
    revealMemoryFile: runtime.host.revealMemoryFile,
    logSystem: runtime.host.logSystemEvent,
  });
}

async function handleMcp(runtime: RouterRuntime, rawInput: string): Promise<void> {
  await handleMcpCommand(rawInput, {
    control: runtime.props.mcpSessionControl,
    selectedServerIds: () => runtime.sessionMcpState().selectedServerIds,
    setSelectedServerIds: (selectedServerIds) =>
      runtime.setSessionMcpState(
        createSessionMcpState({ ...runtime.sessionMcpState(), selectedServerIds }),
      ),
    recordSelection: async (selectedServerIds) => {
      await runtime.props.sessionRecorder?.recordMcpSelection(selectedServerIds, "command");
    },
    sessionToolGrants: () => runtime.sessionMcpState().toolGrants,
    setSessionToolGrants: (toolGrants) =>
      runtime.setSessionMcpState(
        createSessionMcpState({ ...runtime.sessionMcpState(), toolGrants }),
      ),
    recordToolGrants: async (toolGrants) => {
      await runtime.props.sessionRecorder?.recordMcpToolGrants(toolGrants, "command");
    },
    agentMode: () => runtime.host.getAgentMode?.() ?? "normal",
    requestChoice: runtime.host.requestChoice,
    ...(runtime.host.requestMcpManager ? { requestManager: runtime.host.requestMcpManager } : {}),
    ...(runtime.host.dismissMcpManager ? { dismissManager: runtime.host.dismissMcpManager } : {}),
    logSystem: runtime.host.logSystemEvent,
  });
}

async function handleSkills(runtime: RouterRuntime, rawInput: string): Promise<void> {
  await handleSkillsCommand(rawInput, {
    snapshot: runtime.skillSnapshot,
    diagnose: runtime.props.diagnoseSkills,
    logSystem: (message) => runtime.host.logSystemEvent(message),
  });
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
  promptInput: PromptInput,
  userInput: string,
): Promise<void> {
  let submittedUserMessage: Message | undefined;
  let activeTurnId: string | undefined;
  // Set before awaiting completeTurn: a partial append must not be retried as a second closure.
  let turnClosureAttempted = false;

  try {
    const resolved = await materializePromptInput(runtime, promptInput).finally(() =>
      releasePromptResources(promptInput).catch((error) =>
        runtime.host.logSystemEvent(
          `Prompt resource cleanup failed: ${formatPersistenceError(error)}\n`,
        ),
      ),
    );
    activeTurnId = createTurnId();
    // The session layer marks the turn start here (inputKind: "initial"); the status line's
    // timer must anchor at exactly this point so steers and maintenance commands never
    // start (or restart) a turn.
    runtime.host.onTurnStart?.();
    const committed = await commitUserInput(runtime, activeTurnId, "initial", resolved);
    submittedUserMessage = committed.message;
    const turnMcpSelection = new Set(frozenUserInputMcpServerIds(committed.frozen));
    const selectedServerIds = () =>
      [...new Set([...runtime.sessionMcpState().selectedServerIds, ...turnMcpSelection])].sort();
    const mcpBindingFactory = runtime.mcpBindingFactory
      ? createAuthorizedMcpBindingFactory({
          bindingFactory: runtime.mcpBindingFactory,
          control: runtime.props.mcpSessionControl,
          confirmTool: runtime.host.confirmTool,
          state: {
            get: runtime.sessionMcpState,
            commitSelection: async (next) => {
              await runtime.props.sessionRecorder?.recordMcpSelection(
                next.selectedServerIds,
                "tool",
              );
              runtime.setSessionMcpState(next);
            },
            commitToolGrants: async (next) => {
              await runtime.props.sessionRecorder?.recordMcpToolGrants(next.toolGrants, "tool");
              runtime.setSessionMcpState(next);
            },
          },
          effectiveSelectedServerIds: selectedServerIds,
        })
      : undefined;

    const result = await UnifiedAgentWithAbort({
      message: submittedUserMessage,
      history: runtime.history,
      pendingUserMessages: () =>
        drainAndPrepareSteerMessages(runtime, activeTurnId!, turnMcpSelection),
      sessionBlobRoot: runtime.props.sessionBlobRoot,
      sessionRecorder: runtime.props.sessionRecorder,
      sessionId: runtime.props.sessionId,
      turnId: activeTurnId,
      mcpBindingFactory,
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
      props.seedContext ?? [],
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
    const [storedSessionMcpState, storeSessionMcpState] = equipMemory<SessionMcpState>(
      "main_cli:mcp_state",
      props.seedMcpState ?? createSessionMcpState(),
    );
    const [storedNextImageOrdinal, storeNextImageOrdinal] = equipMemory<number>(
      "main_cli:next_image_ordinal",
      props.sessionRecorder?.nextImageOrdinal ?? 1,
    );
    // Local mirrors initialized from the carried values and updated live during the turn (the
    // equipMemory getters are frozen at entry, so we mirror writes here for same-turn reads).
    let liveContextTokens = storedContextTokens;
    let liveCacheTokens = storedCacheTokens;
    let liveSessionMcpState = storedSessionMcpState;
    let liveNextImageOrdinal = storedNextImageOrdinal;
    const setSessionMcpState = (state: SessionMcpState) => {
      liveSessionMcpState = state;
      storeSessionMcpState(state);
    };
    const setNextImageOrdinal = (ordinal: number) => {
      liveNextImageOrdinal = ordinal;
      storeNextImageOrdinal(ordinal);
      host.setNextImageOrdinal?.(ordinal);
    };
    host.setNextImageOrdinal?.(liveNextImageOrdinal);
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

    const memoryRuntime = expectResource<SessionMemoryRuntime>(MEMORY_RUNTIME_PROVIDER_KEY, {
      optional: true,
    });
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
      resolveMcpUserInput: props.resolveMcpUserInput,
      sessionMcpState: () => liveSessionMcpState,
      setSessionMcpState,
      nextImageOrdinal: () => liveNextImageOrdinal,
      setNextImageOrdinal,
      mcpBindingFactory: props.mcpBindingFactory,
      memoryRuntime,
    };

    try {
      host.setAvailableMemories?.(
        memoryRuntime?.epoch.entries.map((entry) => ({
          id: entry.id,
          scope: entry.scope,
          title: entry.title,
          summary: entry.summary,
        })) ?? [],
      );
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
        case "mcp":
          await handleMcp(runtime, intent.rawInput);
          return reborn();
        case "memory":
          await handleMemory(runtime, intent.rawInput);
          return reborn();
        case "skills":
          await handleSkills(runtime, intent.rawInput);
          return reborn();
        case "message":
          await runConversationTurn(runtime, intent.promptInput, intent.userInput);
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
