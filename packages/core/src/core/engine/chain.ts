import type { AgentContext } from "../context/type";
import type { ModelAdapter } from "../domain/model";

/**
 * Find model adapter in context chain
 *
 * Searches current context, then parent, then grandparent, etc.
 */
export function findModelInContextChain(ctx: AgentContext): ModelAdapter | undefined {
  if (ctx.model) return ctx.model;
  if (!ctx.parentContext) return undefined;
  return findModelInContextChain(ctx.parentContext);
}
