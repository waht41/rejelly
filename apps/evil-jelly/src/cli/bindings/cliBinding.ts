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
import { resetInterruptibleTaskStack } from "../../shared/task-interruption/taskStack";
import { resetToolTranscriptViewSession } from "../conversation-display/tool-transcript/viewStore";
import {
  resetOutputSession,
  TOOL_FULL_CAP,
  useOutputStore,
} from "../conversation-display/useOutputStore";
import {
  resetComposerSession,
  useComposerSession,
} from "../message-composer/session/composerSession";
import type { DecisionView } from "../operator-decision/model";
import {
  createOperatorDecision,
  resetOperatorDecisionSession,
} from "../operator-decision/operatorDecision";
import { resetModeSession, useModeStore } from "../tool-approval/approvalModeStore";
import { createToolApproval } from "../tool-approval/createToolApproval";
import { createInkGetInput } from "./getInput";
import { createInkLifecycle } from "./inkLifecycle";
import { resetLineInputQueue } from "./lineInputQueue";

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
  resetLineInputQueue();
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
  seedInput: string | undefined;
  suspendInkForExternalProcess: <T>(fn: () => Promise<T>) => Promise<T>;
}): PromptInputBindings & AgentModeBindings & ToolConfirmationBindings {
  const { seedInput, suspendInkForExternalProcess } = options;
  const decision = createOperatorDecision();
  return {
    getInput: createInkGetInput(seedInput !== undefined ? { seedLine: seedInput } : undefined),
    confirmTool: createToolApproval({
      suspendInkForExternalProcess,
      getMode: () => useModeStore.getState().mode,
      decision,
    }),
    getAgentMode: () => useModeStore.getState().mode,
    requestChoice: createInkRequestChoice(),
    setAvailableSkills: (skills) => {
      useComposerSession.getState().setAvailableSkills(skills);
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
}

/**
 * Resets prompt/output stores, mounts Ink, and builds host bindings from the output store.
 * Caller owns the run flow and must call dispose when finished.
 */
export function createCliHostBindings(options: CreateCliHostBindingsOptions): {
  bindings: EvilJellyBindings;
  dispose: () => void;
} {
  const { version, seedInput, reviewCliFlag } = options;
  resetCliBindingSession();

  const lifecycle = createInkLifecycle();
  const outputBindings = createOutputBindings();
  const promptBindings = createPromptBindings({
    seedInput,
    suspendInkForExternalProcess: lifecycle.suspendForExternalProcess,
  });
  const showBanner = () => showSessionBanner(version);

  logCliStartup(outputBindings.logSystemEvent, showBanner, reviewCliFlag);
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
