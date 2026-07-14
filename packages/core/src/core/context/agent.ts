/**
 * Agent Definition Layer Types
 *
 * Types related to Agent static configuration and function signatures.
 */

import type { ModelAdapter } from "../domain/model";
import { kConfig, kHandler, kOriginalHandler } from "../shared/symbols";
import type { RebornSignal } from "./lifecycle";

/**
 * Agent configuration
 */
export interface AgentConfig<Props = unknown, Result = unknown> {
  /** Unique identifier for the agent */
  id: string;
  /** Model: adapter instance, or string id to resolve from runWith's modelRegistry (shared.modelRegistry) */
  model?: string | ModelAdapter;
  /** Max retries for validation failures (default: 3) */
  maxRetries?: number;
  /** Max LLM turns in the promptAgent loop (default: 10; each turn may include multiple tool calls). */
  maxTurnSteps?: number;
  /**
   * Max reborn events before the loop throws RebornLimitExceededError (default: 100).
   * Counts reborns, not generations: `maxReborns` reborns => `maxReborns + 1` generations
   * (the initial generation is not a reborn). Liveness backstop against reborn loops that
   * never converge (e.g. a counter kept in a handler local that resets each reborn).
   */
  maxReborns?: number;
  /** Agent handler function */
  handler: AgentHandler<Props, Result>;
  /** Static middleware chain (optional, set by augment) */
  middlewares?: AgentMiddleware<Props, Result>[];
}

/**
 * Options for agent.fork()
 */
export type AgentForkOptions<Props = unknown, Result = unknown> = Partial<
  AgentConfig<Props, Result>
>;
/**
 * Agent handler function type
 *
 * Smart type: if Props can be assigned to undefined (void, undefined, or all optional properties),
 * then props parameter is optional; otherwise it's required.
 */
export type AgentHandler<Props = unknown, Result = unknown> = undefined extends Props
  ? (props?: Props) => Promise<Result | RebornSignal<Props>>
  : (props: Props) => Promise<Result | RebornSignal<Props>>;

/**
 * Public result of an agent call.
 *
 * RebornSignal is an internal control-flow value. createAgent catches it and
 * re-runs the handler, so it should not appear in the callable agent return.
 */
export type AgentReturn<Result> = Exclude<Result, RebornSignal<any>>;

/**
 * Agent as a callable function
 *
 * when Props allows undefined, the parameter becomes optional.
 */
export interface AgentFunction<Props = unknown, Result = unknown> {
  /**
   * Execute the agent handler
   */
  (
    ...args: undefined extends Props
      ? [props?: Props]
      : Record<string, never> extends Props
        ? [props?: Props]
        : [props: Props]
  ): Promise<AgentReturn<Result>>;

  /**
   * Unique identifier for the agent
   */
  readonly id: string;

  /**
   * Fork a new agent instance with merged configuration (immutable)
   *
   * @param options - Configuration options to override
   * @returns New agent instance with merged config
   */
  fork(options: AgentForkOptions<Props, Result>): AgentFunction<Props, Result>;
}

/**
 * @internal
 * Internal Agent Function
 *
 * Agent interface used exclusively for internal framework routing, containing underlying Symbol metadata.
 * Completely invisible in public APIs and IDE tooltips.
 */
export type InternalAgentFunction<Props = unknown, Result = unknown> = AgentFunction<
  Props,
  Result
> & {
  readonly [kConfig]: AgentConfig<Props, Result>;
  /**
   * Handler function (internal, accessed via Symbol)
   * Used for internal operations and debugging
   */
  readonly [kHandler]: AgentHandler<Props, Result>;
  /**
   * Original handler before any enchantments (only present if agent was enchanted)
   * Used for flattening optimization to avoid nested wrappers
   */
  readonly [kOriginalHandler]?: AgentHandler<Props, Result>;
};

/**
 * Agent context for middleware execution
 *
 * Provides unified context for agent middleware, containing agent information,
 * input parameters. Middleware can modify props, which will be passed to the
 * handler and inner middlewares.
 */
export interface AgentMiddlewareContext<Props = unknown> {
  /** Agent ID */
  agentId: string;
  /** Agent input parameters (mutable - middleware can modify this) */
  props: Props;
}

/**
 * Agent middleware interface
 *
 * Middleware must be an object with name, handler, and optional config.
 */
export interface AgentMiddleware<Props = unknown, Result = unknown> {
  /** Middleware name (for debugging and logging) */
  name: string;

  /** The middleware handler function */
  handler: (ctx: AgentMiddlewareContext<Props>, next: () => Promise<Result>) => Promise<Result>;

  /** Optional: config snapshot for debugging/dashboard display */
  config?: Record<string, unknown>;
}
