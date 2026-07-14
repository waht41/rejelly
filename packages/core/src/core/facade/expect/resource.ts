/**
 * Expect Resource
 *
 * Declares and reads resource dependencies from parent agents.
 * Traverses the context chain to find exposed resources.
 */

import { getCurrentContext } from "../../context/accessor";
import type { AgentContext } from "../../context/type";
import { ResourceNotFoundError } from "../../domain/errors";

/**
 * Recursively find resource in context chain
 *
 * Traverses from current context up to root, looking for the resource
 * in each context's providers map.
 *
 * @param ctx - Starting context
 * @param key - Resource key to find
 * @returns Resource value if found, undefined otherwise
 */
function findResourceInChain(ctx: AgentContext | undefined, key: string): unknown | undefined {
  if (!ctx) {
    return undefined;
  }

  // 1. Check current context's providers
  if (ctx.providers?.has(key)) {
    return ctx.providers.get(key)?.value;
  }

  // 2. Check parent context (recursive)
  if (ctx.parentContext) {
    return findResourceInChain(ctx.parentContext, key);
  }

  return undefined;
}

/**
 * Expect resource
 *
 * Declares a resource dependency and retrieves it from parent agents.
 *
 * **Semantics**: Current agent **declares** it depends on a runtime resource
 * (e.g., database connection, HTTP client) provided by a parent agent.
 *
 * **Behavior**:
 * 1. Traverse parent context chain
 * 2. Look for resource in each context's `providers` map
 * 3. Return first match found (closest parent wins)
 * 4. **Fail Fast**: Throw `ResourceNotFoundError` if not found (unless optional is true)
 *
 * **Usage Pattern**:
 * - Parent agent calls `equipResource(key, { ..., expose: true })`
 * - Child agent calls `expectResource<T>(key)` to get the resource
 *
 * @param key - Resource identifier (must match key used in equipResource)
 * @param options - Optional configuration
 * @param options.optional - If true, returns undefined instead of throwing when resource is not found
 * @returns Resource instance (typed as T), or T | undefined if optional is true
 * @throws {ResourceNotFoundError} If resource is not found in context chain and optional is false
 *
 * @example
 * // Parent agent: create and expose resource
 * const ParentAgent = createAgent({
 *   handler: async () => {
 *     const db = await equipResource('database', {
 *       create: () => connectDB(),
 *       destroy: (conn) => conn.close(),
 *       deps: [],
 *       expose: true // <--- Key: expose to children
 *     });
 *
 *     equipScope({ tenantId: '1001' });
 *     return await ChildAgent();
 *   }
 * });
 *
 * @example
 * // Child agent: declare and use resource (required)
 * const ChildAgent = createAgent({
 *   handler: async () => {
 *     // Get data dependency
 *     const { tenantId } = expectScope(z.object({ tenantId: z.string() }));
 *
 *     // Get resource dependency (required - throws if not found)
 *     const db = expectResource<Database>('database');
 *
 *     // Use resource
 *     return await db.query('SELECT * FROM users WHERE tenant_id = ?', [tenantId]);
 *   }
 * });
 *
 * @example
 * // Child agent: declare and use resource (optional)
 * const ChildAgent = createAgent({
 *   handler: async () => {
 *     // Get optional resource (returns undefined if not found)
 *     const cache = expectResource<Cache>('cache', { optional: true });
 *
 *     if (cache) {
 *       // Use cache if available
 *       return await cache.get('key');
 *     }
 *     // Fallback behavior
 *     return null;
 *   }
 * });
 */

// Overload 1: Default case, returns T (without undefined)
export function expectResource<T = unknown>(key: string): T;
// Overload 2: Explicitly marked as optional, returns T | undefined
export function expectResource<T = unknown>(
  key: string,
  options: { optional: true },
): T | undefined;
// Implementation
export function expectResource<T = unknown>(
  key: string,
  options?: { optional?: boolean },
): T | undefined {
  const ctx = getCurrentContext();

  // Traverse context chain to find resource
  const resource = findResourceInChain(ctx, key);

  if (resource === undefined) {
    // Only return undefined if explicitly marked as optional
    if (options?.optional) {
      return undefined;
    }

    // Default behavior: throw error
    throw new ResourceNotFoundError(
      key,
      `Resource "${key}" was not found in the context chain. ` +
        `Ensure a parent agent has called equipResource('${key}', { ..., expose: true }).`,
    );
  }

  return resource as T;
}
