/**
 * Instrument
 *
 * Wrap an object's selected methods so each call is traced as an `instrument:op` span.
 *
 * Type-agnostic: the target may be any injected dependency (storage client, payment SDK,
 * vector DB, ...). This is the call-level observability primitive — it sits alongside
 * `equipResource`'s lifecycle-level `resource:op` span and the user-authored
 * `withCustomSpan`. It does NOT change behavior; it only observes.
 *
 * Design notes (see docs/draft/storage-design.md §3.3):
 * - **Explicit `ops`, not a full Proxy of every method.** Only the listed methods are
 *   wrapped; everything else passes through untouched. This avoids three failure modes of
 *   blanket proxying: (1) chainable builders like `redis.multi()` returning a pipeline
 *   rather than a Promise; (2) trace noise from a client's internal method calls;
 *   (3) leaking raw args (PII / huge payloads) into the trace.
 * - **Raw args/results/errors are never recorded by default.** Provide `derive` to
 *   attach small, sanitized `meta` objects to the span instead.
 * - Intended for async (Promise-returning) operations: a traced call always resolves a
 *   Promise, since the span wrapper awaits the underlying result.
 */

import { startTimer } from "../../utils/clock";
import { getCurrentContextSafe } from "../context/accessor";
import { toErrorInfo } from "../domain/errors";
import { withSpan } from "../observability/trace";
import { logger } from "../shared/logger/instance";

export interface InstrumentBaseContext {
  /** Span category name, surfaced on every event (e.g. 'redis', 'stripe'). */
  name: string;
  /** Operation = the invoked method name. */
  operation: string;
  /** Raw operation arguments. Never recorded unless derived by the caller. */
  args: unknown[];
}

export interface InstrumentSuccessContext extends InstrumentBaseContext {
  /** Discriminant for unified downstream handlers. */
  success: true;
  /** Raw operation result. Never recorded unless derived by the caller. */
  result: unknown;
  /** Duration in ms. */
  duration: number;
}

export interface InstrumentErrorContext extends InstrumentBaseContext {
  /** Discriminant for unified downstream handlers. */
  success: false;
  /**
   * Raw thrown value. The serialized ErrorInfo is still recorded automatically
   * on the end event; derive from this only for safe domain metadata.
   */
  error: unknown;
  /** Duration in ms. */
  duration: number;
}

export interface InstrumentDeriveOptions {
  /**
   * Derive metadata from the call before the operation runs.
   * The returned fields are recorded on start and merged into end metadata.
   */
  call?: (ctx: InstrumentBaseContext) => Record<string, unknown>;
  /**
   * Derive metadata from a successful result.
   * The returned fields are merged into end metadata after call metadata.
   */
  result?: (ctx: InstrumentSuccessContext) => Record<string, unknown>;
  /**
   * Derive metadata from the raw thrown value.
   * The returned fields are merged into end metadata after call metadata.
   */
  error?: (ctx: InstrumentErrorContext) => Record<string, unknown>;
}

/**
 * Options for {@link instrument}.
 */
export interface InstrumentOptions<T> {
  /** Span category name, surfaced on every event (e.g. 'redis', 'stripe'). */
  name: string;
  /**
   * Explicit list of method names to trace. Members not listed here (including
   * non-functions and chainable builders) are returned untouched.
   */
  ops: (keyof T)[];
  /**
   * Derive redacted metadata recorded on the span.
   * Callbacks receive raw arguments/results/errors; return only small, PII-safe
   * objects. Raw values themselves are never recorded by default.
   */
  derive?: InstrumentDeriveOptions;
}

/**
 * Instrument an object for call-level tracing.
 *
 * Returns a same-shaped wrapper: listed methods emit `instrument:op` start/end spans
 * around each invocation; all other access is forwarded to the original target. When no
 * trace is active (no agent context), the span wrapper is a no-op and the call runs
 * directly.
 *
 * @example
 * const db = instrument(new Redis(url), {
 *   name: 'redis',
 *   ops: ['get', 'set', 'incr', 'expire'],
 *   derive: {
 *     call: ({ args: [key] }) => ({ key }), // record the key, never the value
 *     result: ({ result }) => ({ hit: result != null }),
 *   },
 * });
 * // provide via runWith({ providers: { db } }); read via expectResource('db')
 */
export function instrument<T extends object>(target: T, options: InstrumentOptions<T>): T {
  const { name, ops, derive } = options;
  const traced = new Set<PropertyKey>(ops as PropertyKey[]);

  return new Proxy(target, {
    get(obj, prop, receiver) {
      const member = Reflect.get(obj, prop, receiver);

      if (typeof member !== "function") {
        return member;
      }

      // Pass-through methods: bind to the real target so private state / chaining work
      // even though the caller invoked them on the proxy.
      if (!traced.has(prop)) {
        return member.bind(obj);
      }

      const op = String(prop);
      return (...args: unknown[]) =>
        withSpan("instrument:op", async (emitter) => {
          const elapsed = startTimer();
          // This op's own span trace; derive metadata is merged here so it lands as
          // verbatim span attributes (same canonical bag as withCustomSpan / equipTraceAttr).
          // The start-event snapshot holds the call-time subset; the end-event snapshot, taken
          // after mergeAttributes below, holds the full set — start is never relied on to complete it.
          const spanTrace = getCurrentContextSafe()?.trace;
          const baseContext: InstrumentBaseContext = { name, operation: op, args };
          const callMeta = safelyDeriveMeta(() => derive?.call?.(baseContext), name, op, "call");
          mergeAttributes(spanTrace, callMeta);
          emitter?.instrumentOpStart({ name, operation: op });
          try {
            // Apply to the original target (not the proxy) to keep `this` identity stable.
            const result = await member.apply(obj, args);
            const duration = elapsed();
            const resultMeta = safelyDeriveMeta(
              () =>
                derive?.result?.({
                  ...baseContext,
                  success: true,
                  result,
                  duration,
                }),
              name,
              op,
              "result",
            );
            mergeAttributes(spanTrace, resultMeta);
            emitter?.instrumentOpEnd({
              name,
              operation: op,
              duration,
              success: true,
            });
            return result;
          } catch (error) {
            const duration = elapsed();
            const errorMeta = safelyDeriveMeta(
              () =>
                derive?.error?.({
                  ...baseContext,
                  success: false,
                  error,
                  duration,
                }),
              name,
              op,
              "error",
            );
            mergeAttributes(spanTrace, errorMeta);
            emitter?.instrumentOpEnd({
              name,
              operation: op,
              duration,
              success: false,
              error: toErrorInfo(error),
            });
            throw error;
          }
        });
    },
  });
}

function safelyDeriveMeta(
  derive: () => Record<string, unknown> | undefined,
  name: string,
  operation: string,
  hook: keyof InstrumentDeriveOptions,
): Record<string, unknown> | undefined {
  try {
    return derive();
  } catch (error) {
    logger.error("instrument derive hook failed", {
      name,
      operation,
      hook,
      error: toErrorInfo(error),
    });
    return undefined;
  }
}

/**
 * Merge derived metadata into the span's trace attributes (the canonical span-attribute bag).
 * No-op when there is no active trace (instrument is a no-op outside an agent context) or
 * nothing was derived. Each call replaces the object so already-emitted event snapshots
 * (deep-cloned at emit time) are unaffected.
 */
function mergeAttributes(
  trace: { attributes?: Record<string, unknown> } | undefined,
  extra: Record<string, unknown> | undefined,
): void {
  if (!trace || !extra) return;
  trace.attributes = { ...(trace.attributes ?? {}), ...extra };
}
