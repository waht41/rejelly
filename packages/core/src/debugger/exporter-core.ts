/**
 * Exporter Core Engine
 *
 * Generic batch exporter that handles:
 * - Event subscription
 * - Batch buffering
 * - Timed flushing
 *
 * Shutdown / flush-on-exit is opt-in via registerShutdown (IoC). The core does not
 * attach global process listeners — higher layers may pass registerNodeShutdown or
 * bind ctx.waitUntil(disable()) in Workers.
 *
 * This is the shared engine used by both OTLP and Review exporters.
 */

import type { TraceEvent } from "../core/domain/events";
import type { EventBus } from "../core/observability/event-bus";
import { getGlobalEventBus } from "../core/observability/event-bus";
import type { ExporterRegisterShutdown } from "./types";

// ============ Types ============

type MaybePromise<T> = T | Promise<T>;

export interface ExporterConfig<T> {
  // Base configuration
  batchSize?: number;
  flushInterval?: number;
  maxQueueSize?: number;

  // Dependency injection
  eventBus?: EventBus;

  /**
   * Host binds when to flush remaining batch (signals, visibility, waitUntil, etc.).
   * Receives forceFlush; may return a cleanup function run when the exporter is disabled
   * (sync or async — disable() awaits async cleanup).
   */
  registerShutdown?: ExporterRegisterShutdown;

  // Core logic hooks
  filter?: (event: TraceEvent) => boolean; // Decide whether to process this event
  transform: (event: TraceEvent) => MaybePromise<T | T[] | null | undefined>; // Convert event to target format
  send: (batch: T[]) => Promise<void>; // Send data
}

// ============ Core Engine ============

export const normalizePositiveInteger = (value: number | undefined, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }

  return Math.floor(value);
};

/**
 * Create a batch exporter with the given configuration
 *
 * @param config - Exporter configuration
 * @returns Disable function that flushes remaining events
 */
export function createBatchExporter<T>(config: ExporterConfig<T>): () => Promise<void> {
  // Merge defaults
  const opts = {
    batchSize: 10,
    flushInterval: 5000,
    maxQueueSize: 5000,
    ...config,
  };

  // Ensure eventBus is always defined
  const eventBus = opts.eventBus ?? getGlobalEventBus();

  const pendingBatch: T[] = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let shutdownCleanup: (() => void | Promise<void>) | null = null;
  let flushing: Promise<void> | null = null;
  const pendingTransforms = new Set<Promise<void>>();
  let orderedTransformTail: Promise<void> | null = null;
  const flushBatchSize = normalizePositiveInteger(opts.batchSize, 10);
  const maxQueueSize = normalizePositiveInteger(opts.maxQueueSize, 5000);

  const enqueue = (item: T): void => {
    if (pendingBatch.length >= maxQueueSize) {
      console.warn("[Exporter] Queue full, dropping oldest event (Backpressure)");
      pendingBatch.shift();
    }

    pendingBatch.push(item);

    // Send batch if threshold reached
    if (pendingBatch.length >= flushBatchSize) {
      flush().catch(console.error);
    }
  };

  const enqueueTransformed = (item: T | T[] | null | undefined): void => {
    if (item == null) return;

    if (Array.isArray(item)) {
      for (const batchItem of item) {
        enqueue(batchItem);
      }
      return;
    }

    enqueue(item);
  };

  /**
   * Flush pending batch
   */
  const flushOnce = async (): Promise<void> => {
    const itemsToProcess = pendingBatch.length;
    let processed = 0;

    while (processed < itemsToProcess && pendingBatch.length > 0) {
      const batchToSend = pendingBatch.splice(0, flushBatchSize);
      processed += batchToSend.length;
      await opts.send(batchToSend);
    }
  };

  const flush = async (): Promise<void> => {
    if (flushing) return flushing;

    flushing = Promise.resolve()
      .then(flushOnce)
      .finally(() => {
        flushing = null;
      });

    return flushing;
  };

  const awaitPendingTransforms = async (): Promise<void> => {
    while (pendingTransforms.size > 0) {
      await Promise.allSettled([...pendingTransforms]);
    }
  };

  const forceFlush = async (): Promise<void> => {
    await awaitPendingTransforms();
    await flush();
  };

  const isPromiseLike = <U>(value: U | Promise<U>): value is Promise<U> =>
    typeof value === "object" && value !== null && "then" in value;

  // 1. Subscribe to events
  unsubscribe = eventBus.subscribe("*", (event) => {
    if (opts.filter && !opts.filter(event)) return;

    try {
      const item = opts.transform(event);

      if (!orderedTransformTail && !isPromiseLike(item)) {
        enqueueTransformed(item);
        return;
      }

      const previousTail = orderedTransformTail;
      const transformed = isPromiseLike(item) ? item : Promise.resolve(item);
      const orderedTransform = (previousTail ?? Promise.resolve())
        .then(() => transformed)
        .catch((e) => {
          console.error("[Exporter] Transform error:", e);
          return undefined;
        })
        .then(enqueueTransformed);

      let transformTail: Promise<void>;
      transformTail = orderedTransform.finally(() => {
        if (orderedTransformTail === transformTail) {
          orderedTransformTail = null;
        }
      });
      orderedTransformTail = transformTail;

      pendingTransforms.add(transformTail);
      transformTail.finally(() => {
        pendingTransforms.delete(transformTail);
      });
    } catch (e) {
      console.error("[Exporter] Transform error:", e);
    }
  });

  // 2. Setup flush timer
  flushTimer = setInterval(() => {
    flush().catch(console.error);
  }, opts.flushInterval);

  // Allow process to exit even with active timer
  if (flushTimer.unref) {
    flushTimer.unref();
  }

  // 3. Optional host shutdown hook (e.g. registerNodeShutdown or custom)
  if (opts.registerShutdown) {
    const maybeCleanup = opts.registerShutdown(() => forceFlush());
    if (typeof maybeCleanup === "function") {
      shutdownCleanup = maybeCleanup;
    }
  }

  // Return disable function
  return async () => {
    // Cleanup logic
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (shutdownCleanup) {
      const runCleanup = shutdownCleanup;
      shutdownCleanup = null;
      await Promise.resolve(runCleanup());
    }
    // Flush remaining batch
    while (pendingBatch.length > 0) {
      await forceFlush();
    }
    await forceFlush();
  };
}
