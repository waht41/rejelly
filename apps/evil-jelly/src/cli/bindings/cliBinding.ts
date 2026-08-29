/**
 * Wires Ink Dashboard UI to {@link EvilJellyBindings}.
 */

import { env, getReviewEndpointFromEnv } from "../../shared/configuration/env";
import { getWorkspaceFsPolicy } from "../../shared/fs-policy/workspace-fs-policy";
import type { EvilJellyBindings } from "../../shared/host/bindings";
import type {
  PromptChoiceRequest,
  PromptChoiceView,
  PromptInputBindings,
} from "../../shared/host/inputBindings";
import type { AgentModeBindings } from "../../shared/host/modeBindings";
import type { ConversationPresentationBindings } from "../../shared/host/presentationBindings";
import type { ToolConfirmationBindings } from "../../shared/host/toolConfirmationBindings";
import { formatStartupTimelineSummary } from "../../shared/profile/startup/summary";
import { startupTimeline } from "../../shared/profile/startup/timeline";
import { resetInterruptibleTaskStack } from "../../shared/task-interruption/taskStack";
import { resetToolTranscriptViewSession } from "../conversation-display/tool-transcript/viewStore";
import {
  resetOutputSession,
  TOOL_FULL_CAP,
  useOutputStore,
} from "../conversation-display/useOutputStore";
import type { InteractiveRunControl } from "../entry/unified-run/interactive/runControl";
import { createInteractiveShell } from "../interactive-shell/inkLifecycle";
import { createInteractiveSubmission } from "../interactive-shell/submission";
import { revealMemoryFileInExplorer } from "../memory-manager/openMemoryStore";
import {
  resetComposerSession,
  useComposerSession,
} from "../message-composer/session/composerSession";
import { useDecisionStore } from "../operator-decision/decisionStore";
import type { DecisionView } from "../operator-decision/model";
import {
  createOperatorDecision,
  resetOperatorDecisionSession,
} from "../operator-decision/operatorDecision";
import { openSkillFolderInFileManager } from "../skill-manager/openSkillFolder";
import { resetSubmissionDispatch } from "../submission-dispatch/dispatcher";
import { resetModeSession, useModeStore } from "../tool-approval/approvalModeStore";
import { createToolApproval } from "../tool-approval/createToolApproval";
import { createInkRequestMemoryConfirmation } from "./memoryConfirmation";

function toDecisionView(view?: PromptChoiceView): DecisionView | undefined {
  if (view === undefined) {
    return undefined;
  }
  if (view.type === "none") {
    return { type: "none" };
  }
  return view;
}

function resetCliBindingSession(): void {
  resetSubmissionDispatch();
  resetOperatorDecisionSession();
  resetComposerSession();
  resetOutputSession();
  resetModeSession();
  resetToolTranscriptViewSession();
  resetInterruptibleTaskStack("CLI binding session reset");
}

function createInkRequestChoice(): PromptInputBindings["requestChoice"] {
  const decision = createOperatorDecision();
  return async (request: PromptChoiceRequest): Promise<string> => {
    return decision.run(async (session) => {
      useOutputStore.getState().setPhase("awaiting_user", "Waiting for user choice…");
      const selected = await session.requestChoice({
        ...request,
        view: toDecisionView(request.view),
      });
      useOutputStore.getState().resumeWork("Running…");
      return selected;
    });
  };
}

function createInkRequestMemoryManager(): NonNullable<PromptInputBindings["requestMemoryManager"]> {
  const decision = createOperatorDecision();
  return async (request) =>
    decision.run(async (session) => {
      useOutputStore.getState().setPhase("awaiting_user", "Browsing persistent memory…");
      const action = await session.requestMemoryManager(request);
      useOutputStore.getState().resumeWork("Running…");
      return action;
    });
}

function createInkRequestMcpManager(): NonNullable<PromptInputBindings["requestMcpManager"]> {
  const decision = createOperatorDecision();
  return async (request) => {
    return decision.run(async (session) => {
      useOutputStore.getState().setPhase("awaiting_user", "Managing MCP servers…");
      const action = await session.requestMcpManager(request);
      useOutputStore.getState().resumeWork("Running…");
      return action;
    });
  };
}

function createInkRequestSkillManager(): NonNullable<PromptInputBindings["requestSkillManager"]> {
  const decision = createOperatorDecision();
  return async (request) =>
    decision.run(async (session) => {
      useOutputStore.getState().setPhase("awaiting_user", "Browsing local Skills…");
      const action = await session.requestSkillManager(request);
      useOutputStore.getState().resumeWork("Running…");
      return action;
    });
}

function createOutputBindings(): ConversationPresentationBindings {
  const out = () => useOutputStore.getState();

  return {
    printOut: (message: string) => {
      out().appendStream(message);
    },
    logToolRound: (calls: number) => {
      out().logToolRound(calls);
    },
    logToolStart: (start) => out().beginTool(start),
    appendToolOutput: (toolCallId: string, chunk: string) => {
      out().appendToolOutput(toolCallId, chunk);
    },
    logUserMessage: (message: string) => {
      out().logUser(message);
    },
    logAssistantMessage: (message: string) => {
      out().logAssistant(message);
    },
    logSystemEvent: (message: string) => {
      out().logSystem(message);
    },
    hydrateHistory: (items) => {
      out().hydrateHistory(items);
    },
    clearHistory: () => {
      out().clearHistory();
    },
    logToolBlock: (block) => {
      const full =
        block.fullResult.length > TOOL_FULL_CAP
          ? block.fullResult.slice(0, TOOL_FULL_CAP)
          : block.fullResult;
      out().logTool({ ...block, fullResult: full });
    },
    onDetailUpdate: (detail: string) => {
      out().setDetail(detail);
    },
    onPhaseUpdate: (phase) => {
      out().setPhase(phase);
    },
    onTurnStart: () => {
      out().beginTurn();
    },
  };
}

/** Session banner at the top of a fresh view: model + workspace directory (startup, /clear). */
function showSessionBanner(version: string): void {
  useOutputStore.getState().logBanner({
    model: env.OPENAI_MODEL_ID,
    dir: getWorkspaceFsPolicy().getRoot(),
    version,
  });
}

function logCliStartup(
  logSystemEvent: ConversationPresentationBindings["logSystemEvent"],
  showBanner: () => void,
  reviewCliFlag: boolean | undefined,
): void {
  showBanner();
  logSystemEvent("Type a message, or / for commands (/exit to quit).");
  if (reviewCliFlag) {
    logSystemEvent(`Review enabled: ${getReviewEndpointFromEnv()}`);
  }
}

function createPromptBindings(options: {
  getInput: PromptInputBindings["getInput"];
  suspendInkForExternalProcess: <T>(fn: () => Promise<T>) => Promise<T>;
}): PromptInputBindings & AgentModeBindings & ToolConfirmationBindings {
  const { getInput, suspendInkForExternalProcess } = options;
  const decision = createOperatorDecision();
  return {
    getInput,
    confirmTool: createToolApproval({
      suspendInkForExternalProcess,
      getMode: () => useModeStore.getState().mode,
      decision,
    }),
    requestMemoryConfirmation: createInkRequestMemoryConfirmation(),
    getAgentMode: () => useModeStore.getState().mode,
    requestChoice: createInkRequestChoice(),
    requestMcpManager: createInkRequestMcpManager(),
    requestMemoryManager: createInkRequestMemoryManager(),
    requestSkillManager: createInkRequestSkillManager(),
    revealMemoryFile: async (scope) => {
      await suspendInkForExternalProcess(() =>
        revealMemoryFileInExplorer({ scope, workspaceRoot: getWorkspaceFsPolicy().getRoot() }),
      );
    },
    openSkillFolder: async (rootPath) => {
      await suspendInkForExternalProcess(() => openSkillFolderInFileManager(rootPath));
    },
    dismissMcpManager: () => useDecisionStore.getState().submitMcpManager({ action: "refresh" }),
    setAvailableSkills: (skills) => {
      useComposerSession.getState().setAvailableSkills(skills);
    },
    setAvailableMcpServers: (servers) => {
      useComposerSession.getState().setAvailableMcpServers(servers);
    },
    setAvailableMemories: (memories) => {
      useComposerSession.getState().setAvailableMemories(memories);
    },
    setNextImageOrdinal: (ordinal) => {
      useComposerSession.getState().setNextImageOrdinal(ordinal);
    },
  };
}

export interface CreateCliHostBindingsOptions {
  /** CLI package version supplied by the composition root. */
  version: string;
  /** Passed to createInkGetInput when set (first line without prompting). */
  seedInput?: string;
  /** When true, logs review endpoint (matches CLI `--review` only, not env-only enable). */
  reviewCliFlag?: boolean;
  /** Per-invocation control shared by Ink, submission dispatch, and the interactive run loop. */
  runControl: InteractiveRunControl;
}

/**
 * Resets prompt/output stores, mounts Ink, and builds host bindings from the output store.
 * Caller owns the run flow and must call dispose when finished.
 */
export function createCliHostBindings(options: CreateCliHostBindingsOptions): {
  bindings: EvilJellyBindings;
  dispose: () => void;
} {
  const { version, seedInput, reviewCliFlag, runControl } = options;
  startupTimeline.mark("cli_bindings_started");
  resetCliBindingSession();
  useOutputStore.getState().setPhase("awaiting_user", "Starting runtime…");
  startupTimeline.mark("cli_session_reset");

  const submission = createInteractiveSubmission(
    {
      requestExit: () => runControl.loop.request({ type: "exit" }),
      requestRunAbort: runControl.segment.requestAbort,
    },
    seedInput !== undefined ? { seedLine: seedInput } : undefined,
  );
  startupTimeline.mark("cli_submission_ready");
  const lifecycle = createInteractiveShell({
    requestRunAbort: runControl.segment.requestAbort,
    cancelSubmission: submission.cancel,
  });
  startupTimeline.mark("cli_shell_ready");
  const outputBindings = createOutputBindings();
  const promptBindings = createPromptBindings({
    getInput: async () => {
      const startupReport = startupTimeline.finish("input_ready");
      if (startupReport) {
        outputBindings.logSystemEvent(formatStartupTimelineSummary(startupReport));
      }
      return submission.getInput();
    },
    suspendInkForExternalProcess: lifecycle.suspendForExternalProcess,
  });
  const showBanner = () => showSessionBanner(version);

  logCliStartup(outputBindings.logSystemEvent, showBanner, reviewCliFlag);
  startupTimeline.mark("cli_bindings_ready");
  return {
    bindings: {
      ...promptBindings,
      ...outputBindings,
      clearScreen: lifecycle.clearScreen,
      showSessionBanner: showBanner,
    },
    dispose: lifecycle.dispose,
  };
}
