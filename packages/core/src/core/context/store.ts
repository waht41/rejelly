/**
 * Context Store
 *
 * Provides async context management using AsyncLocalStorage (node:async_hooks).
 * Requires a runtime that resolves `node:async_hooks` (Edge: enable platform Node compatibility, e.g. `nodejs_compat` on Cloudflare).
 *
 * Architecture:
 * - StorageBackend<T>: Generic low-level storage interface
 * - ContextStore: Business-level store with context-specific logic
 * - wrapStorageBackend: Factory to wrap any backend with business capabilities
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { MaxDepthExceededError } from "../domain/errors";
import type { AgentContext } from "./type";

/** Maximum call depth to prevent infinite recursion */
const MAX_DEPTH = 50;

/**
 * Run options for agent context
 */
interface RunOptions {
  /** Whether to increment depth (default: true) */
  incDepth?: boolean;

  /**
   * Defines the parent context for the current run:
   * - undefined (default): Automatically inherits the context from the current store.
   * - null: Explicitly specifies no parent (creates a root context).
   * - AgentContext: Uses the provided context as the direct parent.
   */
  parentContext?: AgentContext | null;
}

/**
 * Generic storage backend interface
 *
 * This interface is not tied to AgentContext - it only cares about
 * making data accessible during callback execution.
 */
interface StorageBackend<T = unknown> {
  /**
   * Run callback with store available
   */
  run<R>(store: T, callback: () => R | Promise<R>): R | Promise<R>;

  /**
   * Get current store value
   */
  getStore(): T | undefined;
}

/**
 * Context store interface
 *
 * Unified business store interface with context-specific logic:
 * - Depth tracking and overflow protection
 * - Parent context chain management
 *
 * Can be used by agents, callLLM, and other fine-grained components.
 *
 * @see wrapStorageBackend for implementation
 */
interface ContextStore {
  /**
   * Run callback with context
   */
  run<T>(
    context: AgentContext,
    callback: () => T | Promise<T>,
    options?: RunOptions,
  ): T | Promise<T>;

  /**
   * Get current context
   */
  getStore(): AgentContext | undefined;
}

// ============ Context Store Factory ============

/**
 * Wrap storage backend with business logic
 *
 * Wraps a generic StorageBackend with context-specific business logic:
 * - Automatic depth calculation
 * - Max depth overflow protection
 * - Parent context chain linking
 *
 * @param backend - Low-level storage backend
 * @returns ContextStore with business capabilities
 *
 * @example
 * const backend = new NodeStorageBackend();
 * const store = wrapStorageBackend(backend);
 *
 * store.run(ctx, async () => {
 *   // ctx.depth is automatically calculated
 *   // ctx.parentContext is automatically linked
 * });
 */
export function wrapStorageBackend(backend: StorageBackend<AgentContext>): ContextStore {
  const getStore = () => backend.getStore();

  const run = <T>(
    ctx: AgentContext,
    callback: () => T | Promise<T>,
    options?: RunOptions,
  ): T | Promise<T> => {
    // 1. Get parent context (common logic)
    const parentCtx = options?.parentContext === undefined ? getStore() : options.parentContext;
    if (ctx === parentCtx) {
      throw Error("[Rejelly Error] context's parent context cannot refer itself");
    }

    // 2. Depth calculation (common logic)
    const shouldIncDepth = options?.incDepth ?? true;
    const currentDepth = shouldIncDepth ? (parentCtx?.depth ?? 0) + 1 : (parentCtx?.depth ?? 0);

    // 3. Defensive check: prevent infinite recursion (common logic)
    if (shouldIncDepth && currentDepth > MAX_DEPTH) {
      throw new MaxDepthExceededError(MAX_DEPTH);
    }

    // 4. Assemble context (common logic)
    // Mutate the passed object directly
    ctx.parentContext = parentCtx ?? undefined;
    ctx.depth = currentDepth;

    // 5. Delegate to underlying backend
    return backend.run(ctx, callback);
  };

  return { run, getStore };
}

// ============ Storage Backend Implementations ============

/**
 * AsyncLocalStorage-backed implementation
 */
class NodeStorageBackend implements StorageBackend<AgentContext> {
  private storage = new AsyncLocalStorage<AgentContext>();

  run<R>(store: AgentContext, callback: () => R | Promise<R>): R | Promise<R> {
    return this.storage.run(store, callback as () => R);
  }

  getStore(): AgentContext | undefined {
    return this.storage.getStore();
  }
}

// ============ Lazy Initialization ============

/**
 * Versioned global key for cross-package singleton sharing.
 *
 * Keep the major version in the symbol name so incompatible core majors
 * can coexist in one process without corrupting each other's context store.
 */
const CONTEXT_STORE_SYMBOL = Symbol.for("@rejelly/core/context-store/v1");

/**
 * Process-global context store singleton (lazy).
 *
 * First call constructs `wrapStorageBackend(new NodeStorageBackend())`: AsyncLocalStorage
 * from `node:async_hooks` for async context, plus depth limits and parent-context chaining
 * from `wrapStorageBackend`. Subsequent calls return the same instance until `resetContextStore`.
 *
 * This function is import-side-effect free: global state is touched only when called.
 */
export function getContextStore(): ContextStore {
  const globalStore = globalThis as typeof globalThis & Record<symbol, ContextStore | undefined>;

  if (!globalStore[CONTEXT_STORE_SYMBOL]) {
    globalStore[CONTEXT_STORE_SYMBOL] = wrapStorageBackend(new NodeStorageBackend());
  }
  return globalStore[CONTEXT_STORE_SYMBOL] as ContextStore;
}
