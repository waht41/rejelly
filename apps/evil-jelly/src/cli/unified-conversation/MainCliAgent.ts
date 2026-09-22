/** CLI application router for one interactive conversation session. */

import { createAgent, expectResource, isAbortError, type Message, reborn } from "@rejelly/core";
import type { McpSessionControl } from "../../domains/mcp/management/sessionControl";
import {
  MEMORY_RUNTIME_PROVIDER_KEY,
  type SessionMemoryRuntime,
} from "../../domains/memory/runtime/sessionMemoryRuntime";
import type { SessionRecorder } from "../../domains/session/recorder/sessionRecorder";
import type {
  SessionBudget,
  SessionContextTokenAnchor,
} from "../../domains/session/repository/sessionStore";
import {
  SKILL_RUNTIME_PROVIDER_KEY,
  type SkillRuntimeSnapshot,
} from "../../domains/skills/agent/skillRuntime";
import type { ConversationAgentProps } from "../../features/unified/conversationRun";
import { UnifiedAgent } from "../../features/unified/UnifiedAgent";
import { env } from "../../shared/configuration/env";
import { countConversationTurns } from "../../shared/conversation/compactionMessages";
import { getWorkspaceRoot } from "../../shared/fs-policy/workspace-context";
import type { EvilJellyBindings } from "../../shared/host/bindings";
import { getBinding, setBinding } from "../../shared/host/context";
import {
  createSessionMcpState,
  type SessionMcpState,
} from "../../shared/model/mcp/sessionMcpState";
import {
  isPromptInputSemanticallyEmpty,
  type PromptInput,
  promptInputCommandText,
  promptInputPlainText,
} from "../../shared/model/prompt/promptInput";
import { startupTimeline } from "../../shared/profile/startup/timeline";
import { registerInterruptibleTask } from "../../shared/task-interruption/taskStack";
import {
  formatSessionStatus,
  formatTokenUsageLine,
} from "../conversation-display/session-summary/format";
import { setRunningCommandHandler } from "../submission-dispatch/dispatcher";
import { createActiveTurnCommands } from "./activeTurnCommands";
import { type ConversationSession, equipConversationSession } from "./conversationSession";
import { tryRequestResume } from "./interactive/resume";
import type { ConversationLoopControl } from "./interactive/runControl";
import { handleMcpCommand, isMcpLocalCommand } from "./mcpCommands";
import { handleMemoryCommand, isMemoryLocalCommand } from "./memoryCommands";
import {
  handleSkillsCommand,
  isSkillsLocalCommand,
  type SkillDoctorReport,
} from "./skillsCommands";
import { executeConversationTurn, type ResolveMcpUserInput } from "./turnExecution";

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
  /** Resume-validated association between seedContext and the latest provider prompt count. */
  seedContextTokenAnchor?: SessionContextTokenAnchor;
  /** Session-level MCP authorization state recovered from its V3 projection. */
  seedMcpState?: SessionMcpState;
  resolveMcpUserInput?: ResolveMcpUserInput;
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
  session: ConversationSession;
  skillSnapshot?: SkillRuntimeSnapshot;
  memoryRuntime?: SessionMemoryRuntime;
}

function classifyRouterIntent(promptInput: PromptInput): RouterIntent {
  if (isPromptInputSemanticallyEmpty(promptInput)) {
    return { kind: "empty" };
  }
  const commandText = promptInputCommandText(promptInput)?.trim();
  const normalized = commandText?.toLowerCase();
  if (normalized === "/exit" || normalized === "exit") return { kind: "exit" };
  if (normalized === "/clear") return { kind: "clear" };
  if (normalized === "/status") return { kind: "status" };
  if (normalized === "/compress") return { kind: "compress" };
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
    budget: runtime.session.currentBudget(),
  });
  runtime.host.logSystemEvent("Goodbye.\n");
}

async function handleClear(runtime: RouterRuntime): Promise<void> {
  const previousBudget = runtime.session.currentBudget();
  runtime.host.clearHistory?.();
  runtime.host.clearScreen?.();
  runtime.host.showSessionBanner?.();
  const summary = [formatTokenUsageLine(previousBudget)];
  if (runtime.props.sessionId && runtime.session.history.length > 0) {
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

async function runInterruptibleConversationOperation<T>(
  name: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const unregisterTask = registerInterruptibleTask({
    type: "agent_thinking",
    name,
    abort: (reason) => {
      if (!controller.signal.aborted) {
        controller.abort(new DOMException(reason || "Stopped by user", "AbortError"));
      }
    },
  });

  try {
    return await operation(controller.signal);
  } finally {
    unregisterTask();
  }
}

function handleStatus(runtime: RouterRuntime): void {
  runtime.host.logSystemEvent(
    formatSessionStatus({
      sessionId: runtime.props.sessionId ?? "(ephemeral)",
      workspace: getWorkspaceRoot(),
      turns: countConversationTurns(runtime.session.history),
      budget: runtime.session.currentBudget(),
      modelId: env.OPENAI_MODEL_ID,
      protocol: env.OPENAI_API_PROTOCOL,
      contextWindow: env.OPENAI_CONTEXT_WINDOW,
    }),
  );
}

async function handleCompress(runtime: RouterRuntime): Promise<void> {
  if (runtime.session.history.length === 0) {
    runtime.host.logSystemEvent("Nothing to compress yet.\n");
    return;
  }
  runtime.host.logSystemEvent("Compressing session history…\n");
  const result = await runInterruptibleConversationOperation(
    "session_compression",
    (operationSignal) =>
      UnifiedAgent({
        history: runtime.session.history,
        operation: "compress",
        sessionBlobRoot: runtime.props.sessionBlobRoot,
        operationSignal,
      }),
  );
  if (!result.compactHistory) {
    runtime.host.logSystemEvent(`${result.reply || "Compression failed."}\n`);
    return;
  }

  runtime.session.replaceHistory(result.compactHistory);
  runtime.session.clearContextTokenAnchor();
  runtime.session.clearLastContextUsage();
  if (runtime.props.sessionRecorder) {
    await runtime.props.sessionRecorder.recordCompaction({
      trigger: "manual",
      replacementHistory: result.compactHistory,
      beforeMessageCount: runtime.session.history.length,
    });
  }
  runtime.host.logSystemEvent(
    `Session compressed: ${runtime.session.history.length} messages → ${result.compactHistory.length} messages.\n`,
  );
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
  await runtime.props.sessionRecorder?.endSegment({
    status: "completed",
    reason: "switch_session",
    budget: runtime.session.currentBudget(),
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
    selectedServerIds: () => runtime.session.mcpState().selectedServerIds,
    setSelectedServerIds: (selectedServerIds) =>
      runtime.session.setMcpState(
        createSessionMcpState({ ...runtime.session.mcpState(), selectedServerIds }),
      ),
    recordSelection: async (selectedServerIds) => {
      await runtime.props.sessionRecorder?.recordMcpSelection(selectedServerIds, "command");
    },
    sessionToolGrants: () => runtime.session.mcpState().toolGrants,
    setSessionToolGrants: (toolGrants) =>
      runtime.session.setMcpState(
        createSessionMcpState({ ...runtime.session.mcpState(), toolGrants }),
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
    requestSkillManager: runtime.host.requestSkillManager,
    openSkillFolder: runtime.host.openSkillFolder,
    logSystem: runtime.host.logSystemEvent,
  });
}

function formatPersistenceError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const MainCliAgent = createAgent<MainCliAgentProps, void>({
  id: "evil_jelly_cli_router",
  handler: async (props) => {
    await setBinding(props);
    const host = getBinding();
    const session = equipConversationSession(
      {
        seedContext: props.seedContext,
        seedBudget: props.seedBudget,
        seedContextTokenAnchor: props.seedContextTokenAnchor,
        seedMcpState: props.seedMcpState,
        initialImageOrdinal: props.sessionRecorder?.nextImageOrdinal,
      },
      host,
    );
    const memoryRuntime = expectResource<SessionMemoryRuntime>(MEMORY_RUNTIME_PROVIDER_KEY, {
      optional: true,
    });
    const runtime: RouterRuntime = {
      props,
      host,
      session,
      skillSnapshot: expectResource<SkillRuntimeSnapshot>(SKILL_RUNTIME_PROVIDER_KEY, {
        optional: true,
      }),
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
      startupTimeline.emitLateMilestone("first_input_dispatched");
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
          if (await handleResume(runtime, intent.rawInput)) return;
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
        case "message": {
          const activeCommands = createActiveTurnCommands({
            showStatus: () => handleStatus(runtime),
            handleSkills: (commandText) => handleSkills(runtime, commandText),
            handleMemory: (commandText) => handleMemory(runtime, commandText),
            handleMcp: (commandText) => handleMcp(runtime, commandText),
            runAtSafeOutputBoundary: host.runAtSafeOutputBoundary,
            logFailure: (error) =>
              host.logSystemEvent(`Background command failed: ${formatPersistenceError(error)}\n`),
          });
          const disposeRunningCommands = setRunningCommandHandler(activeCommands.handle);
          try {
            await executeConversationTurn(
              {
                host,
                session,
                sessionRecorder: props.sessionRecorder,
                sessionId: props.sessionId,
                sessionBlobRoot: props.sessionBlobRoot,
                skillSnapshot: runtime.skillSnapshot,
                memoryRuntime,
                resolveMcpUserInput: props.resolveMcpUserInput,
                mcpBindingFactory: props.mcpBindingFactory,
                mcpSessionControl: props.mcpSessionControl,
                runInterruptibleOperation: runInterruptibleConversationOperation,
              },
              intent.promptInput,
              intent.userInput,
            );
            await activeCommands.waitForPending();
            activeCommands.flushDeferred();
          } finally {
            activeCommands.dispose();
            disposeRunningCommands();
          }
          return reborn();
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        host.logSystemEvent("\n[System] Current task aborted. Returning to router.\n");
        return reborn();
      }
      throw error;
    }
  },
});
