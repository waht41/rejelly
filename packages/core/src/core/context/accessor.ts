import { ContextNotFoundError } from "../domain/errors";
import { getContextStore } from "./store";
import type { AgentContext } from "./type";

/**
 * Get current context (throws if not found)
 *
 * @throws {ContextNotFoundError} If called outside agent handler
 */
export function getCurrentContext(): AgentContext {
  const ctx = getContextStore().getStore();
  if (!ctx) {
    throw new ContextNotFoundError();
  }
  return ctx;
}

/**
 * Get current context safely (returns undefined if not found)
 *
 * Useful for checking if parent context exists.
 */
export function getCurrentContextSafe(): AgentContext | undefined {
  return getContextStore().getStore();
}

/**
 * Run function in context
 */
export function runInContext<T>(context: AgentContext, callback: () => T): T;
export function runInContext<T>(context: AgentContext, callback: () => Promise<T>): Promise<T>;
export function runInContext<T>(
  context: AgentContext,
  callback: (() => T) | (() => Promise<T>),
): T | Promise<T> {
  return getContextStore().run(context, callback as () => T);
}

/**
 * Run async generator in context
 *
 * For async generator functions, the function body executes on first next() call,
 * not when the function is called. This helper ensures each iteration runs within
 * the specified context, so inner code can correctly access the context via
 * getCurrentContext() or getCurrentContextSafe().
 */
export async function* runGeneratorInContext<T>(
  context: AgentContext,
  generator: AsyncGenerator<T>,
): AsyncGenerator<T> {
  const store = getContextStore();
  let iterResult: IteratorResult<T>;

  try {
    do {
      iterResult = await store.run(context, () => generator.next(), {
        incDepth: false,
        parentContext: context.parentContext ?? null,
      });

      if (!iterResult.done) {
        yield iterResult.value;
      }
    } while (!iterResult.done);
  } finally {
    if (typeof generator.return === "function") {
      await store.run(context, () => generator.return(undefined), {
        incDepth: false,
        parentContext: context.parentContext ?? null,
      });
    }
  }
}
