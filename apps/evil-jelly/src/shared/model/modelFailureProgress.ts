const failedStreamProgress = new WeakMap<object, boolean>();

/** Whether the final failed physical model attempt emitted any stream event before throwing. */
export function modelFailureYielded(error: unknown): boolean | undefined {
  return error !== null && typeof error === "object" ? failedStreamProgress.get(error) : undefined;
}

/** Attach host-owned stream progress without mutating provider error objects. */
export function recordModelFailureProgress(error: unknown, yielded: boolean): void {
  if (error !== null && typeof error === "object") {
    failedStreamProgress.set(error, yielded);
  }
}
