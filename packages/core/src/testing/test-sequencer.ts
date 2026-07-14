/**
 * Deterministic test sequencer for concurrency testing.
 *
 * Replaces setTimeout-based timing with explicit step-based control,
 * eliminating flaky tests caused by event loop timing variations.
 *
 * @example
 * ```typescript
 * const seq = new TestSequencer()
 *
 * // In model stream: block until step 1
 * await seq.waitFor(1)
 *
 * // In test orchestration:
 * await seq.tick()          // flush microtasks
 * seq.advanceTo(1)          // release blocked code
 *
 * // In afterEach or try...finally: prevent hang on early exit
 * seq.abort()
 * ```
 */
const ABORT_MESSAGE = "TestSequencer aborted (e.g. test teardown)";

export class TestSequencer {
  private currentStep = 0;
  private waiters = new Set<{
    targetStep: number;
    resolve: () => void;
    reject: (err: Error) => void;
  }>();
  private aborted = false;

  /**
   * Block execution until the sequencer advances to the target step.
   * Returns immediately if the current step is already >= targetStep.
   * Rejects if abort() was called (e.g. after test exit).
   */
  async waitFor(targetStep: number): Promise<void> {
    if (this.aborted) {
      return Promise.reject(new Error(ABORT_MESSAGE));
    }
    if (this.currentStep >= targetStep) return;
    return new Promise((resolve, reject) => {
      this.waiters.add({ targetStep, resolve, reject });
    });
  }

  /**
   * Advance to the specified step, waking all waiters
   * whose target step has been reached.
   * @throws Error if step <= currentStep (sequencer must advance forward only)
   */
  advanceTo(step: number): void {
    if (step <= this.currentStep) {
      throw new Error(
        `TestSequencer.advanceTo: step must be greater than current step (got step=${step}, currentStep=${this.currentStep})`,
      );
    }
    this.currentStep = step;
    for (const waiter of this.waiters) {
      if (this.currentStep >= waiter.targetStep) {
        waiter.resolve();
        this.waiters.delete(waiter);
      }
    }
  }

  /**
   * Abort all pending waiters (reject their Promises) and clear state.
   * Call in afterEach or try...finally so that tests do not hang when
   * they exit early due to assertion failure or uncaught exception.
   */
  abort(): void {
    this.aborted = true;
    const err = new Error(ABORT_MESSAGE);
    for (const waiter of this.waiters) {
      waiter.reject(err);
    }
    this.waiters.clear();
  }

  /**
   * Flush pending microtasks only (no macrotask yield).
   * Call after pushing async operations so they reach their await points.
   * Uses Promise.resolve() so timers (setTimeout etc.) are not run,
   * keeping the test deterministic.
   */
  async tick(rounds = 1): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
    }
  }
}
