/**
 * Wires Ink Dashboard UI to {@link EvilJellyBindings}.
 */

import { env, getReviewEndpointFromEnv } from "../../shared/config";
import { getWorkspaceFsPolicy } from "../../shared/fs-policy/workspace-fs-policy";
import type { EvilJellyBindings } from "../../shared/host/bindings";
import type { PromptChoiceView, PromptInputBindings } from "../../shared/host/inputBindings";
import type { ConversationPresentationBindings } from "../../shared/host/presentationBindings";
import type { ToolConfirmationBindings } from "../../shared/host/toolConfirmationBindings";
import { resetRuntimeTaskStack } from "../../shared/runtime/runtimeControl";
import { resetModeSession, useModeStore } from "../store/useModeStore";
import { resetOutputSession, TOOL_FULL_CAP, useOutputStore } from "../store/useOutputStore";
import type { ActionMenuOption, TransientView } from "../store/usePromptStore";
import { resetPromptSession, usePromptStore } from "../store/usePromptStore";
import { resetViewSession } from "../store/useViewStore";
import { createInkConfirmWrite } from "./confirmWrite";
import { createInkGetInput } from "./getInput";
import { createInkLifecycle } from "./inkLifecycle";
import { resetPromptQueue, runPromptSession } from "./promptQueue";

function toTransientView(view?: PromptChoiceView): TransientView | undefined {
  if (view === undefined) {
    return undefined;
  }
  if (view.type === "none") {
    return { type: "none" };
  }
  return view;
}

function resetCliBindingSession(): void {
  resetPromptQueue();
  resetPromptSession();
  resetOutputSession();
  resetModeSession();
  resetViewSession();
  resetRuntimeTaskStack();
}

function createInkRequestChoice(): PromptInputBindings["requestChoice"] {
  return async (
    message: string,
    options: ActionMenuOption[],
    view?: PromptChoiceView,
  ): Promise<string> => {
    return runPromptSession(async () => {
      useOutputStore.getState().setPhase("awaiting_user", "Waiting for user choice…");
      const selected = await usePromptStore
        .getState()
        .requestActionMenu(message, options, toTransientView(view));
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
}): PromptInputBindings & ToolConfirmationBindings {
  const { seedInput, suspendInkForExternalProcess } = options;
  return {
    getInput: createInkGetInput(seedInput !== undefined ? { seedLine: seedInput } : undefined),
    confirmTool: createInkConfirmWrite({
      suspendInkForExternalProcess,
      getMode: () => useModeStore.getState().mode,
    }),
    getAgentMode: () => useModeStore.getState().mode,
    requestChoice: createInkRequestChoice(),
    setAvailableSkills: (skills) => {
      usePromptStore.getState().setAvailableSkills(skills);
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
