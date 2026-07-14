/**
 * Custom Trace
 *
 * Provides utilities for creating custom trace spans.
 */

import { startTimer } from "../../utils/clock";
import { getCurrentContextSafe } from "../context/accessor";
import { getContextStore } from "../context/store";
import type { AgentContext } from "../context/type";
import { RequiresAgentContextError, toErrorInfo } from "../domain/errors";
import type { TraceContext } from "../domain/trace";
import { generateSpanId } from "../shared/id";
import { resolveEventBus } from "./event-bus";
import { createEmitter, type Emitter } from "./telemetry";

// ============ Types ============

/**
 * Span interface for custom tracing
 *
 * Allows users to set attributes during execution.
 */
export interface Span {
  /** Set a single attribute */
  setAttribute(key: string, value: unknown): void;
  /** Set multiple attributes at once */
  setAttributes(attributes: Record<string, unknown>): void;
}

/**
 * Options for trace function
 */
export interface TraceOptions {
  /** Static attributes to set on span start */
  attributes?: Record<string, unknown>;
}

/**
 * Options for creating a child span (name and optional attributes).
 */
export interface SpanOptions {
  /** Span name for debugging/tracing */
  name: string;
  /** Optional static attributes */
  attributes?: Record<string, unknown>;
}

/**
 * Create a custom trace span
 *
 * Provides a Span object to the callback for setting dynamic attributes.
 * Automatically tracks duration and success/failure status.
 *
 * @param name - Span name
 * @param fn - Async function to execute with span
 * @param options - Optional trace options
 * @returns Promise resolving to function result
 *
 * @example
 * ```typescript
 * await withCustomSpan('step4-write-content', async (span) => {
 *   const content = await callLLM();
 *
 *   // Set dynamic attributes during execution
 *   span.setAttribute('token_count', content.length);
 *   span.setAttribute('model_version', 'gpt-4');
 *
 *   return content;
 * });
 *
 * // With static attributes
 * await withCustomSpan('process-data', async (span) => {
 *   span.setAttribute('processed_at', Date.now());
 *   return processData();
 * }, { attributes: { source: 'api', version: '1.0' } });
 * ```
 */
export async function withCustomSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: TraceOptions,
): Promise<T> {
  const ctx = getCurrentContextSafe();

  if (!ctx) {
    throw new RequiresAgentContextError("withCustomSpan");
  }

  return withSpan({ name, attributes: options?.attributes }, async (emitter) => {
    const elapsed = startTimer();

    // Capture THIS span's trace once and bind it into the span handle, so the
    // handle always tags its own span's trace.attributes (seeded with
    // options.attributes by withSpan) even if the caller stashes the handle and
    // calls setAttribute later under a different ambient context. Same merge as
    // equipTraceAttr({ target: "local" }): the end-event snapshot carries static
    // + runtime, while the start-event snapshot (emitted before fn runs) holds
    // only what was known at start.
    const spanTrace = getCurrentContextSafe()?.trace;
    const span: Span = {
      setAttribute(key: string, value: unknown) {
        if (spanTrace) spanTrace.attributes = { ...(spanTrace.attributes ?? {}), [key]: value };
      },
      setAttributes(attrs: Record<string, unknown>) {
        if (spanTrace) spanTrace.attributes = { ...(spanTrace.attributes ?? {}), ...attrs };
      },
    };

    emitter?.customSpanStart({ name });

    try {
      const result = await fn(span);
      emitter?.customSpanEnd({
        name,
        duration: elapsed(),
        success: true,
      });
      return result;
    } catch (error) {
      emitter?.customSpanEnd({
        name,
        duration: elapsed(),
        success: false,
        error:
          error instanceof Error ? toErrorInfo(error) : { name: "Error", message: String(error) },
      });
      throw error;
    }
  });
}

/**
 * Run a function under a new child span. Uses the current context's trace when present;
 * otherwise runs the function without tracing. Keeps the full runtime context chain via
 * parentContext and records the trace parent explicitly in parentTrace so trace depth
 * can differ from context depth.
 *
 * When trace exists, an emitter is created for the child span and passed to fn so
 * callers can emit start/end events (e.g. instrument:op, resource:op) without creating
 * their own emitter.
 *
 * @param options - Span name (string) or SpanOptions
 * @param fn - Sync or async function to run in the new span; receives emitter (or null when no trace)
 * @returns Promise of the function result
 */
export function withSpan<T>(
  options: string | SpanOptions,
  fn: (emitter: Emitter | null) => T | Promise<T>,
): Promise<T> {
  const ctx = getCurrentContextSafe();
  if (!ctx?.trace) {
    const result = fn(null);
    return result instanceof Promise ? result : Promise.resolve(result);
  }

  const opts = typeof options === "string" ? { name: options } : options;

  const childTrace: TraceContext = {
    traceId: ctx.trace.traceId,
    parentSpanId: ctx.trace.spanId,
    spanId: generateSpanId(),
    attributes: opts.attributes,
  };

  const childCtx: AgentContext = {
    ...ctx,
    trace: childTrace,
    parentTrace: ctx.trace,
  };

  return Promise.resolve(
    getContextStore().run(
      childCtx,
      () => {
        const emitter = createEmitter(
          resolveEventBus(childCtx.eventBus).emit,
          childCtx.trace!,
          childCtx.agentId,
        );
        return fn(emitter);
      },
      {
        incDepth: false,
        parentContext: ctx.parentContext ?? null,
      },
    ),
  );
}
