/**
 * Teardown Registry
 *
 * Manages cleanup functions to be executed when agent completes.
 * Ensures proper resource cleanup in LIFO order with error isolation.
 */

/**
 * Teardown function type
 */
export type TeardownFn = () => void | Promise<void>;

/**
 * Teardown Registry
 *
 * Manages cleanup functions to be executed when agent completes.
 * Functions are executed in reverse order (LIFO) to ensure proper cleanup sequence.
 */
export class TeardownRegistry {
  // Use Array to maintain order, splice for O(n) removal (acceptable for teardown use case)
  private stack: TeardownFn[] = [];
  private isExecuted = false;

  /**
   * Register a cleanup function
   *
   * @param fn - Cleanup function to register
   * @returns Unregister function (can be called to remove the teardown before execution)
   *
   * @example
   * const unregister = teardown.register(async () => {
   *   await dbConnection.close();
   * });
   *
   * // Later, if needed to cancel:
   * unregister();
   */
  register(fn: TeardownFn): () => void {
    const unregister = this.tryRegister(fn);
    if (!unregister) {
      // If already executed, attempting to register is usually a bug
      console.warn("Attempting to register teardown after execution.");
      return () => {};
    }
    return unregister;
  }

  /**
   * Atomically register a cleanup function only if teardown has not run yet.
   *
   * Unlike {@link register}, this surfaces the already-executed state to the
   * caller: it returns the unregister function on success, or `null` if teardown
   * already started/finished. Because the executed check and the push happen in
   * one synchronous call, a caller can branch on the result without a race window
   * — no `await` can interleave between "check" and "register".
   *
   * @param fn - Cleanup function to register
   * @returns Unregister function, or `null` if teardown has already executed
   */
  tryRegister(fn: TeardownFn): (() => void) | null {
    if (this.isExecuted) {
      return null;
    }

    this.stack.push(fn);

    // Return unregister function
    return () => {
      const index = this.stack.indexOf(fn);
      if (index !== -1) {
        this.stack.splice(index, 1);
      }
    };
  }

  /**
   * Execute all cleanup functions
   *
   * Executes all registered teardown functions in reverse order (LIFO).
   * Errors are isolated - one failure won't prevent others from executing.
   *
   * @example
   * // Register in order: DB connection (A), Socket (B)
   * teardown.register(() => closeDB()); // A
   * teardown.register(() => closeSocket()); // B
   *
   * // Execute: B runs first, then A
   * // This ensures Socket closes before DB, preventing issues if Socket cleanup needs DB
   */
  async execute(): Promise<void> {
    // 1. Prevent re-execution
    if (this.isExecuted) {
      return;
    }
    this.isExecuted = true;

    // 2. LIFO (Last In First Out) principle
    // Critical: Resources created later should be cleaned up first
    // Example: DB connection (A) then Socket (B)
    // Cleanup order: B first, then A
    // If A closes first, B's cleanup might fail if it needs DB access
    const reversedStack = [...this.stack].reverse();

    // Clear original stack to release references
    this.stack = [];

    // 3. Error isolation (Promise.allSettled)
    // One resource cleanup failure should not prevent others from cleaning up
    const results = await Promise.allSettled(
      reversedStack.map(async (fn) => {
        try {
          await fn();
        } catch (error) {
          console.error("Teardown error:", error);
          // Log error but swallow it, ensuring execute() itself succeeds
        }
      }),
    );

    // Optional: Check for rejected results and aggregate logs
    const rejected = results.filter((r) => r.status === "rejected");
    if (rejected.length > 0) {
      console.warn(`${rejected.length} teardown function(s) failed during cleanup`);
    }
  }
}
