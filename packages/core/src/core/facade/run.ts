/**
 * Run with Snapshot
 *
 * Functions for running code with snapshot restoration support.
 */

import { startTimer } from "../../utils/clock";
import { IS_PROD } from "../../utils/const";
import { safeClone } from "../../utils/object";
import { getCurrentContextSafe, runInContext } from "../context/accessor";
import { createAgentContext, createEmptyUsageStats } from "../context/factory";
import type { RunResult } from "../context/lifecycle";
import type { AgentFrameSnapshot } from "../context/snapshot";
import type { CreateContextResult, TraceEventEmitter } from "../context/type";
import { toErrorInfo } from "../domain/errors";
import type { ModelAdapter } from "../domain/model";
import { resolveEventBus } from "../observability/event-bus";
import { ensureSysLogBridge } from "../observability/sys-log-bridge";
import { createEmitter } from "../observability/telemetry";
import { REJELLY_ROOT } from "../shared/const";
import { generateSpanId, generateTraceId } from "../shared/id";
import { logger } from "../shared/logger/instance";
import { getSnapshotSchema } from "../snapshot/schema";
import type { AgentSnapshot } from "../snapshot/type";

/**
 * Options for runWith
 */
export interface RunWithOptions<P = unknown> {
  /**
   * Initial props to pass to the function
   */
  initialProps?: P;
  /**
   * Inject snapshot for context restoration
   * If provided, will attempt to restore Root Context from snapshot
   */
  snapshot?: AgentSnapshot;
  /**
   * Custom event emitter for trace events (e.g. send to OpenTelemetry/Datadog).
   * Only emit is required. Pass a simple { emit } object for basic forwarding,
   * or pass an instance from createEventBus() if you need full pub/sub capabilities.
   */
  eventBus?: TraceEventEmitter;
  /**
   * Root-seeded providers (key -> value), read anywhere in the run via `expectResource(key)`.
   *
   * Boundary DI for app-lifetime dependencies (a shared Redis/PG pool, an SDK client).
   * Resolved by walking the parent context chain — the same channel as a parent agent's
   * `equipResource({ expose: true })`. The framework only borrows these; it never destroys
   * them (their lifecycle belongs to the app). Wrap with `instrument()` for call-level tracing.
   */
  providers?: Record<string, unknown>;
  /**
   * Model adapter for root context
   * If provided, will be set on the root context so child agents can inherit it
   */
  model?: ModelAdapter;
  /**
   * Model registry: id -> ModelAdapter. Injected into root context as shared.modelRegistry.
   * Agents can set model: 'expensive-model-id' and resolve from this registry at runtime
   * (e.g. for per-tenant augmented models with withLimit).
   */
  modelRegistry?: Record<string, ModelAdapter>;
  /**
   * Trace context config (for distributed tracing propagation and global tags)
   */
  trace?: {
    /** External trace ID; if not provided, one will be generated */
    traceId?: string;
    /** Parent span ID for attaching the Agent trace to an external trace */
    parentSpanId?: string;
    /** Global initial attributes / tags */
    attributes?: Record<string, unknown>;
  };
  /**
   * Whether to enable snapshot (record journal, saveChildFrame, allow dumpSnapshot).
   * If not set, defaults to IS_DEV (createAgentContext default).
   */
  enableSnapshot?: boolean;
  /**
   * Optional AbortSignal to link with root context (e.g. HTTP or UI cancellation).
   * When aborted, the root context signal aborts with the same reason.
   */
  signal?: AbortSignal;
}

/**
 * Restore context from snapshot frame
 *
 * Restores memory and snapshot data to an existing context.
 *
 * @param ctx - Context to restore data into
 * @param frame - Frame snapshot to restore from
 */
function restoreContextFromFrame(ctx: CreateContextResult["ctx"], frame: AgentFrameSnapshot): void {
  // Restore memory from frame
  for (const [key, value] of Object.entries(frame.memory)) {
    ctx.memory.set(key, value);
  }

  // Restore budgetState from frame
  if (frame.budgetState) {
    ctx.budgetState = structuredClone(frame.budgetState);
  }

  // Set snapshot for replay
  if (frame.callId === REJELLY_ROOT) {
    ctx.snapshot = frame;
  } else {
    ctx.snapshot = {
      agentId: "",
      callId: REJELLY_ROOT,
      journal: { prompt: {}, tool: {} },
      memory: {},
      children: { [frame.callId]: frame },
      state: frame.state,
      budgetState: {
        aggregate: structuredClone(frame.budgetState.aggregate),
        own: createEmptyUsageStats(),
      },
    };
  }
}

/**
 * Run function with optional snapshot restoration
 *
 * If snapshot is provided, restores the context chain from snapshot
 * and runs the function in the restored context.
 *
 * @param fn - Function to execute (with or without props)
 * @param options - Run options including initialProps, snapshot, and eventBus
 * @returns Result of function execution
 *
 * @example
 * ```typescript
 * // Run without parameters
 * const result = await runWith(async () => {
 *   const agent = createAgent({ ... });
 *   return await agent({ input: 'test' });
 * });
 *
 * // Run without snapshot (normal execution with props)
 * const result = await runWith(
 *   async (props: { input: string }) => {
 *     const agent = createAgent({ ... });
 *     return await agent({ input: props.input });
 *   },
 *   { initialProps: { input: 'test' } }
 * );
 *
 * // Run with snapshot (restore from previous execution)
 * const snapshot = dumpSnapshot(); // Saved earlier
 * const result = await runWith(
 *   async (props: { input: string }) => {
 *     const agent = createAgent({ ... });
 *     return await agent({ input: props.input });
 *   },
 *   { initialProps: { input: 'test' }, snapshot }
 * );
 *
 * ```
 */

// Overload for function without parameters
export function runWith<R>(fn: () => Promise<R>, options?: RunWithOptions<void>): RunResult<R>;

// Overload for function with parameters
export function runWith<P, R>(
  fn: (props: P) => Promise<R>,
  options?: RunWithOptions<P>,
): RunResult<R>;

// Implementation
export async function runWith<P, R>(
  fn: ((props: P) => Promise<R>) | (() => Promise<R>),
  options: RunWithOptions<P> | RunWithOptions<void> = {},
): RunResult<R> {
  // Check if there's already a parent context
  // runWith should only be used at the top level
  const parentCtx = getCurrentContextSafe();
  if (parentCtx) {
    throw new Error("[Rejelly] runWith can only be used at the top level");
  }

  const {
    initialProps,
    snapshot,
    eventBus,
    providers,
    model,
    modelRegistry,
    trace: traceOpt,
    enableSnapshot,
    signal: externalSignal,
  } = options;

  // Final snapshot enabled state: explicit option or default (!IS_PROD)
  const isSnapshotEnabled = enableSnapshot ?? !IS_PROD;

  if (IS_PROD) {
    if (isSnapshotEnabled) {
      // Escape hatch: user explicitly set enableSnapshot: true in production
      logger.warn(
        "[runWith] DANGER: enableSnapshot is set to true in production. This can lead to cache penetration and repeated execution of non-idempotent tools. Use with extreme caution.",
      );
    } else if (snapshot != null && snapshot.root != null) {
      // Default: snapshot injection without enabling snapshot — invalid API state, fail fast
      throw new Error(
        "[runWith] Snapshot injection in production is disabled by default to prevent cache penetration disasters. If you strictly need this, you must explicitly set `enableSnapshot: true`. Recommended: Use event trace + restoreSnapshot for replay or audit.",
      );
    }
  }

  // Unified execution: treat all functions as (props: P) => Promise<R>
  // For functions without parameters, P will be void and we pass undefined
  // JavaScript allows passing arguments to functions that don't accept them
  const fnWithProps = fn as (props: P) => Promise<R>;

  // Wrap with initialProps and make it a no-arg function
  const executeFn = async (): Promise<R> => {
    // Pass initialProps (or undefined for void functions)
    return await fnWithProps(initialProps as P);
  };

  // Fold framework logs onto their span as sys:log events for this run (idempotent, once per process).
  ensureSysLogBridge();

  // Always create a persistent root context to ensure traceId consistency.
  const { ctx: rootCtx, cleanup: rootCleanup } = createAgentContext({
    callId: REJELLY_ROOT,
    eventBus,
    providers,
    model,
    enableSnapshot,
    signal: externalSignal,
    shared: modelRegistry != null ? { modelRegistry } : undefined,
    trace: {
      traceId: traceOpt?.traceId ?? generateTraceId(),
      spanId: generateSpanId(),
      parentSpanId: traceOpt?.parentSpanId ?? "",
      attributes: traceOpt?.attributes,
    },
  });

  // Shared payload for runWith:start and runWith:end (avoid duplication)
  const runWithEventBase = {
    props: initialProps,
    config: {
      isProd: IS_PROD,
      enableSnapshot: isSnapshotEnabled,
    },
    dependencies: {
      hasEventBus: !!eventBus,
      hasGlobalModel: !!model,
      registeredModels: modelRegistry ? Object.keys(modelRegistry) : [],
      registeredProviders: providers ? Object.keys(providers) : [],
    },
    restoration:
      snapshot && isSnapshotEnabled
        ? {
            isRestored: true as const,
            sourceProcessId: snapshot.processId ?? "",
            snapshotTimestamp: snapshot.timestamp ?? 0,
            snapshotVersion: snapshot.version ?? 0,
            provenance: snapshot.provenance
              ? {
                  traceId: snapshot.provenance.traceId,
                  spanId: snapshot.provenance.spanId,
                  anchor: snapshot.provenance.anchor,
                  source: snapshot.provenance.source,
                }
              : { traceId: "" },
          }
        : undefined,
  };

  // Snapshot-level business tags are span attributes describing the foreign run that
  // produced the snapshot. Seed them onto the runWith span's canonical bag, namespaced
  // under `restoration.*` so they stay distinct from the current run's own attributes and
  // surface verbatim (as `restoration.<key>`) in OTLP.
  if (snapshot?.metadata && isSnapshotEnabled && rootCtx.trace) {
    rootCtx.trace.attributes = {
      ...(rootCtx.trace.attributes ?? {}),
      ...Object.fromEntries(
        Object.entries(snapshot.metadata).map(([key, value]) => [`restoration.${key}`, value]),
      ),
    };
  }

  const runWithElapsed = startTimer();
  if (rootCtx.trace) {
    const eventBusInstance = resolveEventBus(rootCtx.eventBus);
    const emitter = createEmitter(eventBusInstance.emit, rootCtx.trace, rootCtx.agentId);
    emitter.runWithStart(runWithEventBase);
  }

  // If snapshot is provided, validate and restore context data from frame
  if (snapshot) {
    // Fail Fast: Validate snapshot format before attempting restoration
    // This prevents silent failures that could lead to expensive LLM calls
    const schema = getSnapshotSchema();
    const parseResult = schema.safeParse(snapshot);

    if (!parseResult.success) {
      // Format Zod errors into readable message
      const errorMsg = parseResult.error.errors
        .map((e) => {
          const path = e.path.length > 0 ? e.path.join(".") : REJELLY_ROOT;
          return `${path}: ${e.message}`;
        })
        .join(", ");
      throw new Error(`[Rejelly] Invalid Snapshot format: ${errorMsg}`);
    }

    // Use validated snapshot (TypeScript will infer correct types)
    const validSnapshot = parseResult.data;

    // Restore root context from validated snapshot
    const rootFrame = validSnapshot.root;
    restoreContextFromFrame(rootCtx, rootFrame);
  }

  let runWithResult: unknown;
  let runWithSuccess = true;
  let runWithError: any;

  try {
    // Run function in root context
    const result = await runInContext(rootCtx, executeFn);
    runWithResult = result;
    return result as RunResult<R>;
  } catch (error) {
    runWithSuccess = false;
    runWithError = error;
    throw error;
  } finally {
    // Emit runWith:end event
    if (rootCtx.trace) {
      const eventBusInstance = resolveEventBus(rootCtx.eventBus);
      const emitter = createEmitter(eventBusInstance.emit, rootCtx.trace, rootCtx.agentId);
      const agg = rootCtx.budgetState.aggregate;
      emitter.runWithEnd({
        ...runWithEventBase,
        result: runWithResult,
        duration: runWithElapsed(),
        success: runWithSuccess,
        error: runWithError ? toErrorInfo(runWithError) : undefined,
        metrics: {
          totalPromptTokens: agg.promptTokens,
          totalCompletionTokens: agg.completionTokens,
          totalTokens: agg.totalTokens,
          costs: safeClone(agg.costs),
        },
      });
    }
    await rootCleanup();
  }
}
