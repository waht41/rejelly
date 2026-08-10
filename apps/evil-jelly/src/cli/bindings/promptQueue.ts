import type { LineInputValue } from "../../shared/AgentShared";
import { clearSteers } from "../../shared/runtime/steerControl";

let promptQueue: Promise<void> = Promise.resolve();
let queuedLineInputs: LineInputValue[] = [];
let pendingLineResolver: ((value: LineInputValue) => void) | null = null;
let pendingLineRejecter: ((reason: Error) => void) | null = null;
let awaitingMainInput = false;

/**
 * Ink has one global prompt store. Serialize host prompts so concurrent tool calls cannot overwrite
 * each other's resolver and leave the earlier write confirmation hanging forever.
 */
export function runPromptSession<T>(fn: () => Promise<T>): Promise<T> {
  const previous = promptQueue;
  let release!: () => void;
  promptQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  return previous.then(async () => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
}

/** Reset pending host prompt queue for a fresh CLI session. */
export function resetPromptQueue(): void {
  promptQueue = Promise.resolve();
  queuedLineInputs = [];
  pendingLineResolver = null;
  pendingLineRejecter = null;
  awaitingMainInput = false;
  clearSteers();
}

export function enqueueLineInput(value: LineInputValue): void {
  if (pendingLineResolver) {
    const resolve = pendingLineResolver;
    pendingLineResolver = null;
    pendingLineRejecter = null;
    resolve(value);
    return;
  }
  queuedLineInputs.push(value);
}

/**
 * Reject a blocked top-level `getInput` (used by Ctrl+C run abort). No-op when
 * nothing is waiting. Lets MainCliAgent's `await host.getInput()` throw so the
 * run can unwind to exit instead of hanging on the prompt.
 */
export function failPendingLineInput(reason: Error): void {
  rejectPendingLineInput(reason);
}

export function rejectPendingLineInput(reason: Error): boolean {
  if (pendingLineRejecter) {
    const reject = pendingLineRejecter;
    pendingLineResolver = null;
    pendingLineRejecter = null;
    reject(reason);
    return true;
  }
  return false;
}

export function dequeueLineInput(): Promise<LineInputValue> {
  const next = queuedLineInputs.shift();
  if (next !== undefined) {
    return Promise.resolve(next);
  }
  return new Promise((resolve, reject) => {
    pendingLineResolver = resolve;
    pendingLineRejecter = reject;
  });
}

export function isAwaitingMainInput(): boolean {
  return awaitingMainInput;
}

export function setAwaitingMainInput(value: boolean): void {
  awaitingMainInput = value;
}
