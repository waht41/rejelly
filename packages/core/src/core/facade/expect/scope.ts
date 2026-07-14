/**
 * Expect Scope
 *
 * Declares and reads scope dependencies with Zod validation.
 * Returns deep-readonly objects to prevent mutation.
 */

import type { z } from "zod";
import { deepFreeze } from "../../../utils/object";
import type { DeepReadonly } from "../../../utils/type";
import { getCurrentContext } from "../../context/accessor";
import type { AgentContext, ScopeLayer } from "../../context/type";
import { ExpectScopeError } from "../../domain/errors";

/**
 * Collect all scope layers from current context and ancestors
 *
 * Traverses the parent chain to gather all scope layers.
 * Layers are returned in order from root to leaf (for proper shadowing).
 *
 * @param ctx - Starting context
 * @returns Array of scope layers from root to leaf
 */
function collectScopeLayers(ctx: AgentContext): ScopeLayer[] {
  const layers: ScopeLayer[] = [];

  // Traverse from current to root, collecting layers
  let current: AgentContext | undefined = ctx;
  const contextChain: AgentContext[] = [];

  while (current) {
    contextChain.push(current);
    current = current.parentContext;
  }

  // Reverse to get root-to-leaf order
  contextChain.reverse();

  // Collect layers in root-to-leaf order (for proper shadowing)
  for (const c of contextChain) {
    layers.push(...c.draft.scopeLayers);
  }

  return layers;
}

/**
 * Merge scope layers with key-level replacement (shadowing)
 *
 * Later layers shadow earlier layers at the key level.
 * NO deep merge - if a key exists in a later layer, it completely replaces the earlier value.
 *
 * @param layers - Scope layers from root to leaf
 * @returns Merged scope object
 */
function mergeScopeLayers(layers: ScopeLayer[]): ScopeLayer {
  const result: ScopeLayer = {};

  for (const layer of layers) {
    // Key-level replacement: later layer keys overwrite earlier ones
    // undefined could overwrite earlier value
    for (const key of Object.keys(layer)) {
      result[key] = layer[key];
    }
  }

  return result;
}

/**
 * Expect scope
 *
 * Declares scope dependencies and reads values with Zod validation.
 *
 * **Semantics**: Current agent **declares** it depends on certain environment values.
 *
 * **Behavior**:
 * 1. Traverse parent chain to collect all scope layers
 * 2. Merge layers with key-level shadowing (child overwrites parent)
 * 3. Validate merged result against Zod schema
 * 4. **Fail Fast**: Throw `ScopeError` immediately if validation fails (no token consumption)
 *
 * **Return Value**: Deep Readonly object (Object.freeze applied recursively)
 *
 * @param schema - Zod schema describing expected scope shape
 * @returns Deep-readonly validated scope object
 * @throws {ExpectScopeError} If scope is missing required fields or fails validation
 *
 * @example
 * // Child agent declares dependencies
 * handler: async () => {
 *   const ctx = expectScope(z.object({
 *     userId: z.string(),
 *   }));
 *
 *   // TypeScript knows ctx.userId is string
 *   console.log(ctx.userId);
 *
 *   // ctx.userId = 'xxx'; // ❌ Runtime error (Object.freeze)
 * }
 *
 * @example
 * // Optional fields with defaults
 * const ctx = expectScope(z.object({
 *   debug: z.boolean().default(false),
 *   retries: z.number().default(3)
 * }));
 *
 * @example
 * // Fail fast - no tokens consumed
 * const ctx = expectScope(z.object({
 *   requiredApiKey: z.string() // Throws immediately if not provided
 * }));
 */
export function expectScope<T extends z.ZodTypeAny>(schema: T): DeepReadonly<z.infer<T>> {
  const agentCtx = getCurrentContext();

  // 1. Collect all layers from ancestors
  const layers = collectScopeLayers(agentCtx);

  // 2. Merge with key-level shadowing
  const merged = mergeScopeLayers(layers);

  // 3. Validate with Zod schema
  const result = schema.safeParse(merged);

  if (!result.success) {
    // 4. Fail Fast: throw ScopeError with detailed error info
    throw new ExpectScopeError(result.error);
  }

  // 5. Deep freeze to prevent mutation
  return deepFreeze(result.data) as DeepReadonly<z.infer<T>>;
}
