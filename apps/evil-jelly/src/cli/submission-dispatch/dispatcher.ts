import {
  assertValidPromptInput,
  isPromptInputSemanticallyEmpty,
  normalizePromptInput,
  type PromptInput,
  promptInputCommandText,
  textPromptInput,
} from "../../shared/model/prompt/promptInput";
import {
  dequeueMainInput,
  enqueueMainInput,
  isAwaitingMainInput,
  rejectPendingLineInput,
  resetMainInputQueue,
  setAwaitingMainInput,
} from "./mainInputQueue";
import { mergeSteersIntoDraft } from "./restoreDraft";
import { clearSteers, drainSteers, enqueueSteer } from "./steerQueue";

export interface SubmissionDispatchPorts {
  interruptTask: (reason: string) => string;
  requestExit: () => void;
  requestRunAbort: (reason: string) => boolean;
  restoreDraft: (draft: PromptInput) => void;
  logSystem: (message: string) => void;
  setInputPhase: (phase: "awaiting" | "working") => void;
}

export interface SubmissionDispatcher {
  submit: (input: PromptInput) => void;
  getInput: () => Promise<PromptInput>;
  cancel: (reason: string) => boolean;
}

export interface SubmissionDispatcherOptions {
  /** First line returned without opening the line prompt. */
  seedLine?: string;
}

const USER_STOP_REASON = "Stopped by user (/stop or Esc)";

function abortError(reason: string): Error {
  const error = new Error(reason);
  error.name = "AbortError";
  return error;
}

function normalizedInput(input: PromptInput): PromptInput {
  const normalized = normalizePromptInput(input);
  assertValidPromptInput(normalized);
  return normalized;
}

function restoreSteers(ports: SubmissionDispatchPorts): number {
  const steers = drainSteers();
  const draft = mergeSteersIntoDraft(steers);
  if (draft) {
    ports.restoreDraft(draft);
  }
  return steers.length;
}

export function resetSubmissionDispatch(): void {
  resetMainInputQueue();
  clearSteers();
}

export function createSubmissionDispatcher(
  ports: SubmissionDispatchPorts,
  options?: SubmissionDispatcherOptions,
): SubmissionDispatcher {
  let pendingSeed = options?.seedLine !== undefined;

  return {
    submit: (rawInput) => {
      const input = normalizedInput(rawInput);
      if (isPromptInputSemanticallyEmpty(input)) return;

      const commandText = promptInputCommandText(input)?.trim();
      const command = commandText?.toLowerCase();
      if (command === "/stop") {
        restoreSteers(ports);
        ports.logSystem(ports.interruptTask(USER_STOP_REASON));
        rejectPendingLineInput(abortError(USER_STOP_REASON));
        return;
      }
      if (isAwaitingMainInput()) {
        enqueueMainInput(input);
        return;
      }
      if (command === "/exit" || command === "exit") {
        ports.requestExit();
        ports.logSystem("Goodbye.");
        const reason = "Stopped by user (exit)";
        ports.requestRunAbort(reason);
        rejectPendingLineInput(abortError(reason));
        return;
      }
      if (commandText?.startsWith("/")) {
        ports.logSystem(`${commandText} is not available while the agent is running.`);
        return;
      }
      enqueueSteer(input);
    },

    getInput: async () => {
      if (pendingSeed) {
        pendingSeed = false;
        ports.setInputPhase("working");
        return textPromptInput((options?.seedLine ?? "").trim());
      }
      const pendingSteers = drainSteers();
      if (pendingSteers.length > 0) {
        const [next, ...rest] = pendingSteers;
        for (const input of rest) enqueueMainInput(input);
        ports.setInputPhase("working");
        return next!;
      }
      ports.setInputPhase("awaiting");
      setAwaitingMainInput(true);
      try {
        const input = await dequeueMainInput();
        ports.setInputPhase("working");
        return input;
      } finally {
        setAwaitingMainInput(false);
      }
    },

    cancel: (reason) => {
      restoreSteers(ports);
      return rejectPendingLineInput(abortError(reason));
    },
  };
}
