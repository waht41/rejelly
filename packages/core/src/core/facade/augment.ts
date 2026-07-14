/**
 * Unified Augmentation API
 *
 * Compose multiple middlewares to enhance a ModelAdapter, ToolDefinition, or AgentFunction.
 * Provides a unified API for augmenting models, tools, and agents with middleware chains.
 *
 * This module is part of the core framework, supporting:
 * - Model augmentation: Wrap ModelAdapter with capabilities like rate limiting, monitoring
 * - Tool augmentation: Add static middleware chains to ToolDefinition (combined with dynamic middlewares from equipTool)
 * - Agent augmentation: Add static middleware chains to AgentFunction (applied when agent is called)
 */

import type { z } from "zod";
import type { AgentFunction, AgentMiddleware, InternalAgentFunction } from "../context/agent";
import type { ModelAdapter, ModelMiddleware } from "../domain/model";
import type { ToolDefinition, ToolMiddleware } from "../domain/tool";
import { kConfig, kModelMiddlewares } from "../shared/symbols";

/**
 * Augment a model adapter with middlewares
 *
 * Composes middlewares from right to left (onion model, inside-out).
 *
 * @param baseModel - The base model adapter
 * @param middlewares - Array of middlewares to apply
 * @returns Enhanced model adapter
 *
 * @example
 * const model = augment(openaiAdapter, [
 *   withLimit({ rpm: 60, concurrency: 5 }),
 *   withMonitor({ onCall: (m) => console.log(m) }),
 * ])
 *
 * // Execution order (onion model): array [withLimit, withMonitor] => limit wraps monitor wraps openai
 * // request  → limit → monitor → openai
 * // response ← limit ← monitor ← openai
 */
export function augment(baseModel: ModelAdapter, middlewares: ModelMiddleware[]): ModelAdapter;

/**
 * Augment a tool definition with middlewares
 *
 * "Burns in" static middlewares into the tool definition.
 * These middlewares are applied before dynamic middlewares (from equipTool).
 *
 * @param tool - The base tool definition
 * @param middlewares - Array of tool middlewares to apply
 * @returns Enhanced tool definition with middlewares attached
 *
 * @example
 * const SafeSearchTool = augment(BaseSearchTool, [
 *   wrapLog(),            // Outer: record
 *   wrapRetry({ n: 3 })   // Inner: retry
 * ]);
 */
export function augment<TParams extends z.ZodTypeAny>(
  tool: ToolDefinition<TParams>,
  middlewares: ToolMiddleware[],
): ToolDefinition<TParams>;

/**
 * Augment an agent function with middlewares
 *
 * "Burns in" static middlewares into the agent configuration.
 * These middlewares are applied when the agent is called.
 *
 * @param agent - The base agent function
 * @param middlewares - Array of agent middlewares to apply
 * @returns Enhanced agent function with middlewares attached
 *
 * @example
 * const LoggedAgent = augment(MyAgent, [
 *   {
 *     name: 'log',
 *     handler: async (ctx, next) => {
 *       console.log(`Agent ${ctx.agentId} called with`, ctx.props);
 *       const result = await next();
 *       console.log(`Agent ${ctx.agentId} returned`, result);
 *       return result;
 *     }
 *   }
 * ]);
 */
export function augment<Props = unknown, Result = unknown>(
  agent: AgentFunction<Props, Result>,
  middlewares: AgentMiddleware<Props, Result>[],
): AgentFunction<Props, Result>;

/**
 * @deprecated
 * Implementation: Unified augment function
 *
 * Uses duck typing to determine target type:
 * - ModelAdapter: has `stream` method
 * - ToolDefinition: has `handler` method
 * - AgentFunction: has `id` property and `[kConfig]` symbol
 *
 * Execution order for agent middlewares (onion model):
 * - Middlewares are applied from outer to inner (right to left in array)
 * - Handler is at the center
 * - Example: [mw1, mw2] -> mw1 wraps mw2 wraps handler
 */
export function augment(
  target: ModelAdapter | ToolDefinition | AgentFunction,
  middlewares: ModelMiddleware[] | ToolMiddleware[] | AgentMiddleware[],
): ModelAdapter | ToolDefinition | AgentFunction {
  // 1. Check if target is a ModelAdapter (duck typing: has stream method)
  if (typeof (target as ModelAdapter).stream === "function") {
    return augmentModel(target as ModelAdapter, middlewares as ModelMiddleware[]);
  }

  // 2. Check if target is a ToolDefinition (duck typing: has handler method)
  if (typeof (target as ToolDefinition).handler === "function") {
    return augmentTool(target as ToolDefinition, middlewares as ToolMiddleware[]);
  }

  // 3. Check if target is an AgentFunction (duck typing: has id and kConfig)
  if (
    typeof (target as AgentFunction).id === "string" &&
    (target as InternalAgentFunction)[kConfig]
  ) {
    return augmentAgent(target as AgentFunction, middlewares as AgentMiddleware[]);
  }

  throw new Error(
    "augment target must be a ModelAdapter (has stream method), ToolDefinition (has handler method), or AgentFunction (has id and config)",
  );
}

/**
 * Augment a model adapter with middlewares
 *
 * Composes middlewares from right to left (onion model, inside-out).
 *
 * @param model - The base model adapter
 * @param middlewares - Array of middlewares to apply
 * @returns Enhanced model adapter
 */
export function augmentModel(model: ModelAdapter, middlewares: ModelMiddleware[]): ModelAdapter {
  // Compose from right to left (onion model, inside-out)
  const wrappedModel = middlewares.reduceRight((inner, mw) => {
    return mw.wrap(inner);
  }, model);
  // Attach middleware list for debug (merge with any existing from prior augment)
  const existingMiddlewares =
    (model as unknown as { [kModelMiddlewares]?: ModelMiddleware[] })[kModelMiddlewares] ?? [];
  Object.defineProperty(wrappedModel, kModelMiddlewares, {
    value: [...existingMiddlewares, ...middlewares],
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return wrappedModel;
}

/**
 * Augment a tool definition with middlewares
 *
 * "Burns in" static middlewares into the tool definition.
 * These middlewares are applied before dynamic middlewares (from equipTool).
 *
 * @param tool - The base tool definition
 * @param middlewares - Array of tool middlewares to apply
 * @returns Enhanced tool definition with middlewares attached
 */
export function augmentTool<TParams extends z.ZodTypeAny>(
  tool: ToolDefinition<TParams>,
  middlewares: ToolMiddleware[],
): ToolDefinition<TParams> {
  return {
    ...tool,
    middlewares: [...(tool.middlewares || []), ...middlewares],
  };
}

/**
 * Augment an agent function with middlewares
 *
 * "Burns in" static middlewares into the agent configuration.
 * These middlewares are applied when the agent is called.
 *
 * @param agent - The base agent function
 * @param middlewares - Array of agent middlewares to apply
 * @returns Enhanced agent function with middlewares attached
 */
export function augmentAgent<Props = unknown, Result = unknown>(
  agent: AgentFunction<Props, Result>,
  middlewares: AgentMiddleware<Props, Result>[],
): AgentFunction<Props, Result> {
  const config = (agent as InternalAgentFunction<Props, Result>)[kConfig];
  return agent.fork({ middlewares: [...(config.middlewares || []), ...middlewares] });
}
