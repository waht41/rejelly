/**
 * Equip Resource
 *
 * Resource lifecycle management hook that manages resource creation and destruction
 * based on dependency array. Resources are stored in non-persistent runtime maps.
 */

import { startTimer } from "../../../utils/clock";
import { isDepsShallowEqual } from "../../../utils/object";
import { getCurrentContext } from "../../context/accessor";
import { AbortError, toErrorInfo } from "../../domain/errors";
import { withSpan } from "../../observability/trace";
import { logger } from "../../shared/logger/instance";
import { INTERNAL_RESOURCE_PREFIX } from "./const";
import { equipEphemeral } from "./memory";

/**
 * Resource configuration for equipResource
 */
interface ResourceConfig<T> {
  /** Async function to create the resource */
  create: () => Promise<T>;
  /**
   * Async function to destroy/cleanup the resource.
   *
   * **Optional.** Omit when the resource has no teardown — a pure/derived value, or a
   * borrowed handle the agent does **not** own (e.g. an app-lifetime connection pool
   * injected via `runWith({ providers })`). When omitted, no global teardown is
   * registered and no `resource:op` destroy span is emitted.
   *
   * Presence of `destroy` is the owned-vs-borrowed signal: in place = "I own it, I close
   * it"; absent = "I only borrow/derive it". See docs/draft/storage-design.md §5.
   */
  destroy?: (resource: T) => Promise<void>;
  /**
   * Dependency array (used for cache invalidation)
   * Can contain any type including functions, objects, etc. (non-serializable values allowed)
   */
  deps: unknown[];
  /**
   * Whether to expose this resource to child agents
   * @default false (only visible to current agent)
   */
  expose?: boolean;
}

/**
 * Resource metadata stored in ctx.resources.metadata
 */
interface ResourceMetadata {
  /**
   * Visibility is a declaration-time property of the resource slot. Re-declaring
   * the same key with a different expose value would make DI lookup order-dependent.
   */
  expose: boolean;
  /**
   * Unregister function for global teardown (to prevent duplicate cleanup).
   * Undefined when the resource was created without a `destroy` (nothing registered).
   */
  unregister?: () => void;
  /**
   * Per-instance, at-most-once destroy gate shared by both the global teardown
   * callback and the deps-change cleanup path. Calling it more than once (e.g. a
   * teardown racing a deps change) runs the user's `destroy` only the first time.
   * Undefined when the resource was created without a `destroy`.
   */
  destroyOnce?: () => Promise<void>;
}

/**
 * Wrap a resource's `destroy` in a one-shot gate.
 *
 * The `started` flag flips synchronously *before* awaiting `destroy`, so a second
 * concurrent caller short-circuits immediately even while the first destroy is
 * still in flight. Errors propagate to the caller (each call site decides how to
 * log them); a failed destroy is not retried.
 */
function makeDestroyOnce<T>(resource: T, destroy: (r: T) => Promise<void>): () => Promise<void> {
  let started = false;
  return async () => {
    if (started) return;
    started = true;
    await destroy(resource);
  };
}

function ensureExposeStable(
  key: string,
  metadata: ResourceMetadata | undefined,
  expose: boolean,
): void {
  if (metadata && metadata.expose !== expose) {
    throw new Error(
      `[Rejelly] Resource "${key}" was re-declared with expose:${expose}, ` +
        `but the existing resource slot was declared with expose:${metadata.expose}. ` +
        "Resource exposure is a declaration-time setting and must stay stable.",
    );
  }
}

function exposeResource(
  ctx: ReturnType<typeof getCurrentContext>,
  key: string,
  value: unknown,
): void {
  const existing = ctx.providers?.get(key);
  if (existing && !(existing.origin === "resource" && existing.owner === key)) {
    throw new Error(
      `[Rejelly] Resource "${key}" cannot be exposed because the current context already ` +
        `has a provider binding for that key.`,
    );
  }
  ctx.providers?.set(key, { origin: "resource", owner: key, value });
}

function assertCanExposeResource(ctx: ReturnType<typeof getCurrentContext>, key: string): void {
  const existing = ctx.providers?.get(key);
  if (existing && !(existing.origin === "resource" && existing.owner === key)) {
    throw new Error(
      `[Rejelly] Resource "${key}" cannot be exposed because the current context already ` +
        `has a provider binding for that key.`,
    );
  }
}

function deleteOwnedProviderBinding(ctx: ReturnType<typeof getCurrentContext>, key: string): void {
  const existing = ctx.providers?.get(key);
  if (existing?.origin === "resource" && existing.owner === key) {
    ctx.providers?.delete(key);
  }
}

/**
 * Equip resource (resource management hook)
 *
 * A syntax sugar built on top of equipEphemeral that provides resource lifecycle management.
 * Manages resource creation and destruction based on dependency array.
 * When dependencies change, destroys old resource and creates new one.
 *
 * Dependencies are stored in ephemeral storage (non-serializable), allowing functions,
 * objects, and other non-serializable values to be used as dependencies.
 *
 * **Deps comparison: shallow (React-style).** Uses Object.is per element; reference change
 * means deps changed. This fits resources that are non-serializable or have side effects
 * (sockets, handles, callbacks): keep stable references (e.g. useCallback / extract refs)
 * to avoid unnecessary destroy+create.
 *
 * @param key - Unique key for this resource slot
 * @param config - Resource configuration with create, destroy, and deps
 * @returns Promise that resolves to the resource instance
 *
 * @example
 * // Database connection resource
 * const db = await equipResource('db_conn', {
 *   create: async () => await connectDB(),
 *   destroy: async (conn) => await conn.close(),
 *   deps: [dbConfig.host, dbConfig.port]
 * });
 *
 * @example
 * // File handle resource
 * const file = await equipResource('file_handle', {
 *   create: async () => await openFile(path),
 *   destroy: async (handle) => await handle.close(),
 *   deps: [path]
 * });
 *
 * @example
 * // Resource with function dependencies
 * const processor = await equipResource('processor', {
 *   create: async () => new DataProcessor(transformFn),
 *   destroy: async (proc) => await proc.cleanup(),
 *   deps: [transformFn] // Function is allowed as dependency
 * });
 */
export async function equipResource<T>(key: string, config: ResourceConfig<T>): Promise<T> {
  const { create, destroy, deps } = config;
  const expose = config.expose ?? false;
  const ctx = getCurrentContext();

  // Ensure resource runtime and providers maps exist
  if (!ctx.resources) {
    ctx.resources = { active: new Map(), metadata: new Map() };
  }
  if (!ctx.providers) {
    ctx.providers = new Map();
  }

  // 1. Get stored deps from ephemeral storage (allows non-serializable values like functions)
  const [storedDeps, setStoredDeps] = equipEphemeral<unknown[] | null>(
    `${INTERNAL_RESOURCE_PREFIX}${key}`,
    null,
  );

  // 2. Check if dependencies changed
  const depsChanged = !storedDeps || !isDepsShallowEqual(storedDeps, deps);
  const currentMetadata = ctx.resources.metadata.get(key) as ResourceMetadata | undefined;
  ensureExposeStable(key, currentMetadata, expose);
  if (expose) {
    assertCanExposeResource(ctx, key);
  }

  if (depsChanged) {
    // === 1. Cleanup old resource ===
    const oldResource = ctx.resources.active.get(key) as T | undefined;
    const oldMetadata = currentMetadata;

    if (oldResource) {
      // Old deps: the deps that were used when this resource was created (not the new deps that triggered destroy)
      const oldDeps = storedDeps ?? undefined;
      // A. ✅ Critical: Unregister from global Teardown BEFORE destroying.
      // Doing it first shrinks the window in which teardown.execute() could snapshot this
      // old callback and destroy the same instance concurrently. (Defense-in-depth only —
      // the real at-most-once guarantee is the shared `destroyOnce` gate below.)
      if (oldMetadata?.unregister) {
        oldMetadata.unregister();
      }

      // B. Destroy the old instance through the SAME `destroyOnce` gate that its teardown
      // callback holds. If teardown raced us and already started destroying this instance,
      // the gate short-circuits here, so the user's `destroy` runs at most once.
      const runOldDestroy = oldMetadata?.destroyOnce;
      if (runOldDestroy) {
        await withSpan("resource:op", async (emitter) => {
          const elapsed = startTimer();
          emitter?.resourceOpStart({ operation: "destroy", resourceId: key, deps: oldDeps });
          try {
            await runOldDestroy();
            emitter?.resourceOpEnd({
              operation: "destroy",
              resourceId: key,
              deps: oldDeps,
              duration: elapsed(),
              success: true,
            });
          } catch (error) {
            emitter?.resourceOpEnd({
              operation: "destroy",
              resourceId: key,
              deps: oldDeps,
              duration: elapsed(),
              success: false,
              error: toErrorInfo(error),
            });
            logger.warn(`Failed to destroy resource for key "${key}":`, error);
          }
        });
      }

      // C. ✅ Critical: Clear old resource from context immediately after destroy.
      // If create() below throws, on next reborn storedDeps/resources would still hold the old
      // (already destroyed) instance, leading to double destroy (Double Free/Close).
      ctx.resources.active.delete(key);
      ctx.resources.metadata.delete(key);
      deleteOwnedProviderBinding(ctx, key);
      setStoredDeps(null);
    }

    // === 2. Create new resource ===
    const newResource = await withSpan("resource:op", async (emitter) => {
      const elapsed = startTimer();
      emitter?.resourceOpStart({ operation: "create", resourceId: key, deps });
      try {
        const resource = await create();
        emitter?.resourceOpEnd({
          operation: "create",
          resourceId: key,
          deps,
          duration: elapsed(),
          success: true,
          reused: false,
        });
        return resource;
      } catch (error) {
        emitter?.resourceOpEnd({
          operation: "create",
          resourceId: key,
          deps,
          duration: elapsed(),
          success: false,
          error: toErrorInfo(error),
        });
        throw error;
      }
    });

    // === 3. Register to global Teardown (only when there is something to destroy) ===
    // This ensures resource is released even if user doesn't trigger reborn,
    // and directly closes the Agent. Borrowed/derived resources (no destroy) skip this.
    //
    // Both this teardown callback and the deps-change cleanup path above destroy through the
    // same per-instance `destroyOnce`, so an instance is never destroyed twice even if both
    // paths fire (teardown racing a deps change).
    let unregister: (() => void) | undefined;
    let destroyOnce: (() => Promise<void>) | undefined;
    if (destroy) {
      const onceDestroy = makeDestroyOnce(newResource, destroy);
      destroyOnce = onceDestroy;

      const teardownCallback = async () => {
        try {
          await onceDestroy();
        } catch (error) {
          logger.warn(`Failed to destroy resource for key "${key}" during teardown:`, error);
        }
      };

      // Atomic "register only if teardown hasn't run yet". A null result means
      // teardown.execute() already started/finished while we awaited create() above;
      // registering now would hit the no-op branch and this instance would never be
      // destroyed (a leak with no user-side remedy, since `destroy` is never called).
      // Self-clean and abort this generation instead.
      const registered = ctx.teardown.tryRegister(teardownCallback);
      if (!registered) {
        await teardownCallback();
        throw AbortError.fromSignal(ctx.signal);
      }
      unregister = registered;
    }

    // === 4. Store deps in ephemeral storage (allows non-serializable values) ===
    setStoredDeps(deps);

    // === 5. Store resource instance and metadata in non-persistent resource runtime ===
    ctx.resources.active.set(key, newResource);
    ctx.resources.metadata.set(key, { expose, unregister, destroyOnce });

    // === 6. Expose resource to child agents if requested ===
    if (expose) {
      exposeResource(ctx, key, newResource);
    }

    return newResource;
  }

  // Dependencies unchanged: reuse the active resource instance (emit create hit span).
  const reusedResource = ctx.resources.active.get(key) as T | undefined;

  if (!reusedResource) {
    // This should not happen, but handle gracefully
    throw new Error(`[Rejelly] Resource "${key}" not found in active resources despite reuse hit`);
  }

  await withSpan("resource:op", (emitter) => {
    emitter?.resourceOpStart({ operation: "create", resourceId: key, deps });
    emitter?.resourceOpEnd({
      operation: "create",
      resourceId: key,
      deps,
      duration: 0,
      success: true,
      reused: true,
    });
    return reusedResource;
  });

  // Even when reused, ensure resource is in providers map if expose is enabled
  // (needed because reborn might clear transient state, but memory persists)
  if (expose) {
    exposeResource(ctx, key, reusedResource);
  }

  return reusedResource;
}
