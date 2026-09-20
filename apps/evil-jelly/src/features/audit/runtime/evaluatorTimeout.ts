export class AuditEvaluatorTimeoutError extends Error {
  readonly name = "AuditEvaluatorTimeoutError";

  constructor(readonly timeoutMs: number) {
    super(`Evaluator timed out after ${timeoutMs}ms`);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(signal.reason === undefined ? "Evaluator aborted" : String(signal.reason));
}

type ParentAbortCascade = {
  controllers: Set<AbortController>;
  onAbort: () => void;
};

/**
 * Share one listener for every evaluator linked to the same audit signal. The default audit
 * concurrency is 12, so registering one parent listener per evaluator crosses Node's EventTarget
 * warning threshold even when every listener is eventually cleaned up.
 */
const parentAbortCascades = new WeakMap<AbortSignal, ParentAbortCascade>();

function bindParentAbort(parentSignal: AbortSignal, childController: AbortController): () => void {
  if (parentSignal.aborted) {
    childController.abort(parentSignal.reason);
    return () => undefined;
  }

  let cascade = parentAbortCascades.get(parentSignal);
  if (!cascade) {
    const controllers = new Set<AbortController>();
    const onAbort = () => {
      for (const controller of controllers) {
        controller.abort(parentSignal.reason);
      }
      parentAbortCascades.delete(parentSignal);
    };
    cascade = { controllers, onAbort };
    parentAbortCascades.set(parentSignal, cascade);
    parentSignal.addEventListener("abort", onAbort, { once: true });
  }

  cascade.controllers.add(childController);
  return () => {
    cascade.controllers.delete(childController);
    if (cascade.controllers.size === 0 && !parentSignal.aborted) {
      parentSignal.removeEventListener("abort", cascade.onAbort);
      parentAbortCascades.delete(parentSignal);
    }
  };
}

/**
 * Run one evaluator under its own deadline. The signal is aborted before the timeout rejection is
 * observed, so agent/model/tool work receives a real cancellation request rather than being left
 * behind by a bare Promise.race. The race remains as a liveness backstop for a buggy evaluator that
 * ignores cancellation entirely.
 */
export async function evaluateWithTimeout<T>(
  evaluate: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const unbindParentAbort = parentSignal
    ? bindParentAbort(parentSignal, controller)
    : () => undefined;

  let rejectOnAbort: ((error: Error) => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectOnAbort = reject;
  });
  const rejectFromSignal = () => rejectOnAbort?.(abortError(controller.signal));
  if (controller.signal.aborted) {
    rejectFromSignal();
  } else {
    controller.signal.addEventListener("abort", rejectFromSignal, { once: true });
  }

  const timer = setTimeout(() => {
    controller.abort(new AuditEvaluatorTimeoutError(timeoutMs));
  }, timeoutMs);

  try {
    if (controller.signal.aborted) {
      return await abortPromise;
    }
    return await Promise.race([evaluate(controller.signal), abortPromise]);
  } finally {
    clearTimeout(timer);
    unbindParentAbort();
    controller.signal.removeEventListener("abort", rejectFromSignal);
  }
}
