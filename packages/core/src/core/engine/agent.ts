/**
 * Agent Factory
 *
 * Creates callable agent functions with automatic context management.
 */

import { startTimer } from "../../utils/clock";
import { safeClone } from "../../utils/object";
import { ensureActive } from "../context/abort";
import { getCurrentContextSafe, runInContext } from "../context/accessor";
import type {
  AgentConfig,
  AgentForkOptions,
  AgentFunction,
  AgentMiddleware,
  AgentMiddlewareContext,
  AgentReturn,
} from "../context/agent";
import { createAgentContext, createEmptyRunState } from "../context/factory";
import type { AgentFrameSnapshot } from "../context/snapshot";
import type { AgentContext } from "../context/type";
import {
  isAbortError,
  ModelRegistryNotFoundError,
  RebornLimitExceededError,
  toErrorInfo,
} from "../domain/errors";
import type { ModelAdapter } from "../domain/model";
import type { TraceContext } from "../domain/trace";
import {
  collectResourceKeys,
  snapshotDraftScopeLayers,
  toDraftViewModel,
} from "../observability/draft-view";
import { findEventBusInContext, getGlobalEventBus } from "../observability/event-bus";
import { ensureSysLogBridge } from "../observability/sys-log-bridge";
import { createEmitter } from "../observability/telemetry";
import { REJELLY_ROOT } from "../shared/const";
import { generateSpanId, generateTraceId } from "../shared/id";
import { kConfig, kHandler } from "../shared/symbols";
import { generateCallId } from "../snapshot/id";
import { stopGenerationStreams } from "./effect";
import { isRebornSignal } from "./flow/reborn";

// Re-export for convenience
export { generateTraceId, generateSpanId };

/**
 * Default cap on reborn events per agent invocation. Liveness backstop: a runaway
 * reborn loop throws RebornLimitExceededError instead of burning tokens forever.
 * Generous on purpose — legitimate deep chains override via config.maxReborns.
 */
const DEFAULT_MAX_REBORNS = 100;

// ============ Trace & Frame Helpers ============

/**
 * Merge ctx.draft.traceAttributes into base trace for emission.
 * Returns undefined if baseTrace is undefined; otherwise returns baseTrace or enhanced copy.
 */
function getEnhancedTrace(
  baseTrace: TraceContext | undefined,
  ctx: AgentContext,
): TraceContext | undefined {
  if (!baseTrace) return undefined;
  const extraAttrs = ctx.draft?.traceAttributes;
  if (!extraAttrs || Object.keys(extraAttrs).length === 0) return baseTrace;
  return {
    ...baseTrace,
    attributes: { ...(baseTrace.attributes ?? {}), ...extraAttrs },
  };
}

/**
 * Save child frame snapshot into parent context (for snapshot replay).
 */
function saveChildFrame(
  parentCtx: AgentContext | undefined,
  callId: string,
  ctx: AgentContext,
  state: AgentFrameSnapshot["state"],
): void {
  if (!parentCtx) return;
  if (!ctx.enableSnapshot) return;
  const memory: Record<string, unknown> = {};
  for (const [key, value] of ctx.memory.entries()) {
    memory[key] = value;
  }
  parentCtx.draft.children[callId] = {
    callId,
    agentId: ctx.agentId || REJELLY_ROOT,
    memory,
    journal: {
      prompt: { ...ctx.draft.journal.prompt },
      tool: { ...ctx.draft.journal.tool },
    },
    children: { ...ctx.draft.children },
    budgetState: ctx.budgetState,
    state: {
      status: state.status,
      ...(state.output !== undefined ? { output: state.output } : {}),
      ...(state.error !== undefined ? { error: state.error } : {}),
    },
  };
}

/**
 * Execute agent handler through middleware chain (onion model).
 * Middleware runs after context creation and before handler execution.
 * In reborn flow, this chain is executed once per generation.
 * Keep middleware side effects idempotent.
 */
async function executeAgentHandlerWithMiddlewares<Props, Result>(
  config: AgentConfig<Props, Result>,
  props: Props,
): Promise<Result> {
  const middlewares = config.middlewares || [];
  if (middlewares.length === 0) {
    return config.handler(props) as Promise<Result>;
  }
  const middlewareContext: AgentMiddlewareContext<Props> = {
    agentId: config.id,
    props,
  };
  let next: () => Promise<Result> = async () =>
    (await config.handler(middlewareContext.props)) as Promise<Result>;
  for (let i = middlewares.length - 1; i >= 0; i--) {
    const middleware = middlewares[i] as AgentMiddleware<Props, Result>;
    const currentNext = next;
    next = async () => await middleware.handler(middlewareContext, currentNext);
  }
  return next();
}

// ============ Agent Factory ============

/**
 * Create Agent
 *
 * Returns a callable function that implements "Agent as Function" philosophy:
 * - Call directly with `await MyAgent(props)`, no `.handler` needed
 * - Automatic context creation and reborn loop handling
 * - Preserves `id` for debugging/testing
 *
 * @param config - Agent configuration
 * @returns Callable agent function
 *
 * @example
 * const MyAgent = createAgent({
 *   id: 'my_agent',
 *   model: openaiAdapter,
 *   handler: async (props) => {
 *     equipInstruction(`Analyze: ${props.topic}`);
 *     return await promptAgent(ResponseSchema);
 *   }
 * });
 *
 * // Direct call
 * const result = await MyAgent({ topic: 'AI trends' });
 */
export function createAgent<Props = unknown, Result = unknown>(
  config: AgentConfig<Props, Result>,
): AgentFunction<Props, Result> {
  // Validate required config.id
  if (!config.id || typeof config.id !== "string" || config.id.trim() === "") {
    throw new Error("AgentConfig.id is required and must be a non-empty string");
  }

  // Create callable agent function
  // Runtime parameter is optional to support smart type inference
  const agentFn = async (props?: Props): Promise<AgentReturn<Result>> => {
    // 0. Get parent context
    const parentCtx = getCurrentContextSafe();

    // 1. Generate call ID and check snapshot
    const safeProps = (props ?? ({} as Props)) as Props;
    const callId = generateCallId(parentCtx, "agent", config.id);

    // Record callId in parent's journal.agent for duplicate detection
    if (parentCtx?.draft) {
      parentCtx.draft.journal.agent[callId] = true;
    }

    // Check if we have a matching child frame in parent's snapshot
    let childSnapshot = null;
    if (parentCtx?.snapshot) {
      childSnapshot = parentCtx.snapshot.children[callId] || null;
    }

    // 2. Create trace context
    const trace: TraceContext = {
      traceId: parentCtx?.trace?.traceId ?? generateTraceId(),
      spanId: generateSpanId(),
      parentSpanId: parentCtx?.trace?.spanId ?? "",
    };

    // Fold framework logs onto their span as sys:log events for this run (idempotent, once per process).
    ensureSysLogBridge();

    // Resolve event bus dynamically: config > parent (recursive) > global
    const eventBus = findEventBusInContext(parentCtx) || getGlobalEventBus();

    // Create event emitter with eventBus.emit
    const emitter = createEmitter(eventBus.emit, trace, config.id);

    // Resolve model: string -> from shared.modelRegistry, otherwise use as ModelAdapter
    let resolvedModel: ModelAdapter | undefined;
    if (typeof config.model === "string") {
      const registry = parentCtx?.shared?.modelRegistry;
      resolvedModel = registry?.[config.model];
      if (resolvedModel === undefined) {
        const registeredIds = registry ? Object.keys(registry) : undefined;
        throw new ModelRegistryNotFoundError(config.model, config.id, registeredIds);
      }
    } else {
      resolvedModel = config.model;
    }

    // 3. Create context (with snapshot if available)
    const { ctx, cleanup } = createAgentContext({
      model: resolvedModel,
      maxRetries: config.maxRetries,
      maxTurnSteps: config.maxTurnSteps,
      trace,
      agentId: config.id,
      callId, // Set callId when creating context
      eventBus: eventBus,
    });

    // Set snapshot if available
    if (childSnapshot) {
      ctx.snapshot = childSnapshot;

      // Restore memory from snapshot
      for (const [key, value] of Object.entries(childSnapshot.memory)) {
        ctx.memory.set(key, value);
      }
      ctx.budgetState = safeClone(childSnapshot.budgetState);
    }

    // Record start time
    const totalElapsed = startTimer();

    // Middleware list for events (name + config)
    const middlewares = (config.middlewares ?? []).map((mw) => ({
      name: mw.name,
      config: mw.config,
    }));

    // Resolved reborn cap (config or default); exposed on agent events for observability
    const maxReborns = config.maxReborns ?? DEFAULT_MAX_REBORNS;

    // Emit agent:start
    emitter.agentStart({
      props: safeProps,
      middlewares: middlewares.length > 0 ? middlewares : undefined,
      scopeLayers: snapshotDraftScopeLayers(ctx.draft),
      resourceKeys: collectResourceKeys(ctx),
      maxReborns,
    });

    // 2. Reborn loop
    let currentProps = safeProps;
    let generationCount = 0;
    let generationElapsed: () => number = totalElapsed;
    let executionResult: "success" | "error" | "cancelled" = "error"; // Default to error
    // Variables for generation trace and emitter (declared outside loop for error handling)
    let generationTrace: TraceContext | undefined;
    let generationEmitter: ReturnType<typeof createEmitter> | undefined;
    let currentGenerationId = 0;

    try {
      while (true) {
        // Check abort before each iteration
        ensureActive(ctx);

        // Reset draft before each reborn (keep memory and budgetState)
        ctx.draft = createEmptyRunState();

        // Take current generation id (0, 1, 2...) then increment for next generation
        currentGenerationId = generationCount++;
        generationElapsed = startTimer();

        // Create independent trace context for this generation (child span of agent)
        generationTrace = {
          traceId: trace.traceId,
          spanId: generateSpanId(),
          parentSpanId: trace.spanId,
        };

        // Create independent emitter for generation events
        generationEmitter = createEmitter(eventBus.emit, generationTrace, config.id);

        // Update trace context and generation ID for this generation
        if (ctx.trace) {
          ctx.trace = generationTrace;
        }
        ctx.generationId = currentGenerationId;

        generationEmitter.generationStart({
          generationId: currentGenerationId,
          props: currentProps,
        });

        try {
          // 3. Run middleware + handler in context.
          // This runs after ctx is ready and before actual handler logic.
          // Reborn will re-enter this block, so middleware may run multiple times.
          const result = await runInContext(ctx, () =>
            executeAgentHandlerWithMiddlewares(config, currentProps),
          );

          // Check abort after handler returns
          // Use explicit ctx because we're outside AsyncLocalStorage scope after runInContext completes
          ensureActive(ctx);

          // 4. Check for reborn signal
          if (isRebornSignal(result)) {
            // Liveness guard: refuse the reborn that would exceed maxReborns. currentGenerationId
            // reborns have already happened (gen 0 is the initial run), so this handler return is
            // reborn #(currentGenerationId + 1). Throw before emitting generation:end/agent:reborn,
            // so the failing generation reports a single generation:end (error) via the catch block.
            if (currentGenerationId >= maxReborns) {
              throw new RebornLimitExceededError(maxReborns, currentGenerationId + 1);
            }

            const generationDuration = generationElapsed();

            // Take current count (0, 1, 2...) then increment for next reborn
            const rebornTrace: TraceContext = {
              traceId: trace.traceId,
              spanId: generateSpanId(),
              parentSpanId: generationTrace.spanId,
            };

            // Emit agent:reborn before generation:end. Ordering matters for OTLP export:
            // agent:reborn is a point event whose target span is generationTrace.spanId
            // (rebornTrace.parentSpanId). The OTLP folding exporter attaches a point event to
            // its target span only when that span's :end is exported, so the point event MUST
            // arrive before the span's :end — otherwise it is buffered too late, never attaches,
            // and is dropped as an orphan. See debugger/open-telemetry.ts (point-event folding).
            createEmitter(eventBus.emit, rebornTrace, config.id).agentReborn({
              generationId: currentGenerationId,
              newProps: result.newProps,
            });
            createEmitter(eventBus.emit, generationTrace!, config.id).generationEnd({
              generationId: currentGenerationId,
              props: currentProps,
              endReason: "reborn",
              duration: generationDuration,
              success: true,
              draft: toDraftViewModel(ctx.draft, ctx),
              memory: Object.fromEntries(ctx.memory),
            });

            // Update props (if provided)
            currentProps = (result.newProps as Props) ?? currentProps;
            continue; // Re-run handler (will start new generation)
          }

          // 5. Normal return
          executionResult = "success";
          const generationDuration = generationElapsed();
          const totalDuration = totalElapsed();

          // Emit generation:end (return)
          createEmitter(eventBus.emit, generationTrace!, config.id).generationEnd({
            generationId: currentGenerationId,
            props: currentProps,
            endReason: "return",
            result,
            duration: generationDuration,
            success: true,
            draft: toDraftViewModel(ctx.draft, ctx),
            memory: Object.fromEntries(ctx.memory),
          });
          createEmitter(eventBus.emit, getEnhancedTrace(trace, ctx)!, config.id).agentEnd({
            props: safeProps,
            middlewares: middlewares.length > 0 ? middlewares : undefined,
            scopeLayers: snapshotDraftScopeLayers(ctx.draft),
            resourceKeys: collectResourceKeys(ctx),
            maxReborns,
            result,
            duration: totalDuration,
            success: true,
            generationCount,
          });

          saveChildFrame(parentCtx, callId, ctx, {
            status: "completed",
            output: result,
          });
          return result as AgentReturn<Result>;
        } finally {
          await stopGenerationStreams(ctx, `Generation ${currentGenerationId} ended`);
        }
      }
    } catch (error) {
      const duration = totalElapsed();
      const generationDuration = generationElapsed();
      const err = error as Error;

      const errorInfo = isAbortError(error)
        ? { name: "AbortError", message: "Cancelled" }
        : toErrorInfo(err);

      executionResult = isAbortError(error) ? "cancelled" : "error";

      // Emit generation:end (error) only if we had started at least one generation
      if (generationCount > 0 && generationEmitter) {
        createEmitter(eventBus.emit, generationTrace!, config.id).generationEnd({
          generationId: currentGenerationId,
          props: currentProps,
          endReason: "error",
          duration: generationDuration,
          success: false,
          error: errorInfo,
          draft: toDraftViewModel(ctx.draft, ctx),
          memory: Object.fromEntries(ctx.memory),
        });
      }

      // Always emit end event (with error info)
      createEmitter(eventBus.emit, getEnhancedTrace(trace, ctx)!, config.id).agentEnd({
        props: safeProps,
        middlewares: middlewares.length > 0 ? middlewares : undefined,
        scopeLayers: snapshotDraftScopeLayers(ctx.draft),
        resourceKeys: collectResourceKeys(ctx),
        maxReborns,
        duration,
        success: false,
        error: errorInfo,
        generationCount,
      });

      saveChildFrame(parentCtx, callId, ctx, {
        status: "failed",
        error: errorInfo,
      });

      throw error;
    } finally {
      // Stop child tasks with appropriate reason
      ctx.controller.abort(`Agent ${executionResult}`);
      // 6. Cleanup: teardown registry (LIFO) + clear runtime state + unbind parent-child signal
      await cleanup();
    }
  };

  // Attach metadata (readonly)
  Object.defineProperty(agentFn, "id", {
    value: config.id,
    writable: false,
    enumerable: true,
  });
  Object.defineProperty(agentFn, kHandler, {
    value: config.handler,
    writable: false,
    enumerable: false, // Internal metadata (hidden via Symbol)
  });
  Object.defineProperty(agentFn, kConfig, {
    value: config,
    writable: false,
    enumerable: false, // Internal metadata (hidden via Symbol)
  });

  // Attach fork method (immutable - returns new instance)
  Object.defineProperty(agentFn, "fork", {
    value: (options: AgentForkOptions<Props, Result>): AgentFunction<Props, Result> => {
      // Merge config with new options, creating a new agent
      return createAgent<Props, Result>({
        ...config,
        ...options,
      });
    },
    writable: false,
    enumerable: false,
  });

  // Force type conversion to match the smart AgentFunction type definition
  return agentFn as unknown as AgentFunction<Props, Result>;
}
