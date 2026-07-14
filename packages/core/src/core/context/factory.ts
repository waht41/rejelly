/**
 * Context Factory
 *
 * Functions for creating and managing agent contexts.
 */

import { IS_DEV } from "../../utils/const";
import { TeardownRegistry } from "../../utils/teardown";
import type { BudgetState, UsageStats } from "../domain/budget";
import type { ModelAdapter } from "../domain/model";
import type { TraceContext } from "../domain/trace";
import { REJELLY_ROOT } from "../shared/const";
import { generateTraceId } from "../shared/id";
import { getCurrentContextSafe } from "./accessor";
import type {
  AgentContext,
  AgentRunDraft,
  CreateContextResult,
  SharedContext,
  TraceEventEmitter,
} from "./type";

type ParentAbortCascade = {
  controllers: Set<AbortController>;
  onAbort: () => void;
};

/**
 * One listener per parent signal fans abort out to all live child contexts. A parent may have
 * more than ten concurrent children (for example, an audit evaluator pool); registering one
 * listener per child trips Node's EventTarget warning even though every listener is cleaned up.
 */
const parentAbortCascades = new WeakMap<AbortSignal, ParentAbortCascade>();

function bindParentAbort(parentSignal: AbortSignal, childController: AbortController): () => void {
  if (parentSignal.aborted) {
    childController.abort(parentSignal.reason);
    return () => undefined;
  }

  let cascade = parentAbortCascades.get(parentSignal);
  if (!cascade) {
    const controllers = new Set<AbortController>();
    const onAbort = () => {
      for (const controller of controllers) {
        controller.abort(parentSignal.reason);
      }
      parentAbortCascades.delete(parentSignal);
    };
    cascade = { controllers, onAbort };
    parentAbortCascades.set(parentSignal, cascade);
    parentSignal.addEventListener("abort", onAbort, { once: true });
  }

  cascade.controllers.add(childController);
  return () => {
    cascade.controllers.delete(childController);
    if (cascade.controllers.size === 0 && !parentSignal.aborted) {
      parentSignal.removeEventListener("abort", cascade.onAbort);
      parentAbortCascades.delete(parentSignal);
    }
  };
}

/**
 * Create empty runtime state
 *
 * Called on each reborn to reset transient state.
 */
export function createEmptyRunState(): AgentRunDraft {
  return {
    systemPrompts: [],
    instructions: [],
    validators: [],
    tools: [],
    toolCallLoopMiddlewares: [],
    streamConsumers: [],
    budgetConfigs: [],
    scopeLayers: [],
    journal: {
      prompt: {},
      tool: {},
      agent: {},
    },
    children: {},
    callCounters: {},
    traceAttributes: {},
    steps: 0,
  };
}

/**
 * Create empty usage stats
 */
export function createEmptyUsageStats(): UsageStats {
  return {
    costs: {},
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    callCount: 0,
    items: [],
  };
}

/**
 * Create empty budget state
 */
export function createEmptyBudgetState(): BudgetState {
  return {
    own: createEmptyUsageStats(),
    aggregate: createEmptyUsageStats(),
  };
}

/**
 * Options for creating agent context
 */
export interface CreateAgentContextOptions {
  model?: ModelAdapter;
  maxRetries?: number;
  maxTurnSteps?: number;
  trace?: TraceContext;
  agentId?: string;
  /** Call ID for this context (defaults to 'root' for root context) */
  callId?: string;
  /** Event emitter for this agent (only emit is required for injection) */
  eventBus?: TraceEventEmitter;
  /**
   * Root-seeded providers (key -> value), read via `expectResource(key)`.
   * Boundary DI for app-lifetime dependencies (e.g. a shared connection pool). Seeded
   * into this context's `providers` map; child agents resolve them by walking the parent
   * chain, the same channel as `equipResource({ expose: true })`. The framework only
   * borrows these — it never destroys them.
   */
  providers?: Record<string, unknown>;
  /** Whether to enable snapshot (default: IS_DEV) */
  enableSnapshot?: boolean;
  /** Shared context (e.g. modelRegistry from runWith). Inherited from parent if not set. */
  shared?: SharedContext;
  /**
   * Optional external AbortSignal (e.g. HTTP request cancellation).
   * When aborted, this context's controller is aborted with the same reason.
   */
  signal?: AbortSignal;
}

export function createAgentContext(options?: CreateAgentContextOptions): CreateContextResult {
  // sys:log bridge wiring (an observability concern) is pulled at the run composition roots
  // (engine createAgent / facade runWith), the same way the global event bus is — never from
  // this context layer, which must not depend upward on observability.

  // Get parent context (for cascading signals)
  const parentCtx = getCurrentContextSafe();

  // Create AbortController for this agent
  const controller = new AbortController();

  // Inner cleanup: unbind injected / parent-child signal listeners
  const unbinders: Array<() => void> = [];

  // Optional external signal: forward abort into this context's controller
  const externalSignal = options?.signal;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      const onExternalAbort = () => {
        controller.abort(externalSignal.reason);
      };
      externalSignal.addEventListener("abort", onExternalAbort);
      unbinders.push(() => externalSignal.removeEventListener("abort", onExternalAbort));
    }
  }

  // Implement cascading abort: parent abort triggers child abort
  if (parentCtx?.signal) {
    unbinders.push(bindParentAbort(parentCtx.signal, controller));
  }

  // 1. Create base context
  const baseCtx: AgentContext = {
    // Runtime state (cleared on reborn)
    draft: createEmptyRunState(),

    // Persistent state
    memory: new Map(),
    ephemeral: new Map(),
    teardown: new TeardownRegistry(),

    // Configuration
    depth: 0, // Actual value set in store.run()
    model: options?.model,
    maxRetries: options?.maxRetries ?? 3,
    maxTurnSteps: options?.maxTurnSteps ?? 10,
    parentContext: parentCtx,

    trace:
      options?.trace ??
      ({ traceId: generateTraceId(), spanId: "", parentSpanId: "" } as TraceContext),
    agentId: options?.agentId || "",
    callId: options?.callId ?? REJELLY_ROOT,
    eventBus: options?.eventBus,
    budgetState: createEmptyBudgetState(),
    enableSnapshot: options?.enableSnapshot ?? parentCtx?.enableSnapshot ?? IS_DEV,
    shared: options?.shared ?? parentCtx?.shared,

    // Abort signal
    controller,
    signal: controller.signal,

    // Non-persistent runtime state (cleared on reborn)
    resources: {
      active: new Map(),
      metadata: new Map(),
    },
    providers: options?.providers
      ? new Map(
          Object.entries(options.providers).map(([key, value]) => [
            key,
            { origin: "seeded" as const, value },
          ]),
        )
      : new Map(),
  };

  // Full cleanup: teardown + clear runtime state + unbind signal (reusable for non-Agent top-level entry)
  const cleanup = async (): Promise<void> => {
    await baseCtx.teardown.execute();
    baseCtx.resources?.active.clear();
    baseCtx.resources?.metadata.clear();
    baseCtx.providers?.clear();
    for (const unbind of unbinders) {
      unbind();
    }
  };

  return { ctx: baseCtx, cleanup };
}
