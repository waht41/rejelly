import { releasePromptResources } from "../../shared/host/promptResourceLifecycle";
import { copyPromptInput, type PromptInput } from "../../shared/model/prompt/promptInput";

let queuedLineInputs: PromptInput[] = [];
let pendingLineResolver: ((value: PromptInput) => void) | null = null;
let pendingLineRejecter: ((reason: Error) => void) | null = null;
let awaitingMainInput = false;

/** Reset pending main input for a fresh CLI session. */
export function resetMainInputQueue(): void {
  const discarded = queuedLineInputs;
  queuedLineInputs = [];
  pendingLineResolver = null;
  pendingLineRejecter = null;
  awaitingMainInput = false;
  void Promise.all(discarded.map((input) => releasePromptResources(input))).catch(() => undefined);
}

export function enqueueMainInput(value: PromptInput): void {
  const snapshot = copyPromptInput(value);
  if (pendingLineResolver) {
    const resolve = pendingLineResolver;
    pendingLineResolver = null;
    pendingLineRejecter = null;
    resolve(snapshot);
    return;
  }
  queuedLineInputs.push(snapshot);
}

/**
 * Reject a blocked top-level `getInput` (used by Ctrl+C run abort). No-op when
 * nothing is waiting. Lets MainCliAgent's `await host.getInput()` throw so the
 * run can unwind to exit instead of hanging on the prompt.
 */
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

export function dequeueMainInput(): Promise<PromptInput> {
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
