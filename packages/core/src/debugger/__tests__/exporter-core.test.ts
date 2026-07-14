import { afterEach, describe, expect, it, vi } from "vitest";
import type { TraceEvent } from "../../core/domain/events";
import { createEventBus } from "../../core/observability/event-bus";
import { createBatchExporter } from "../exporter-core";

const createEvent = (id: number): TraceEvent =>
  ({
    type: "debugger:test",
    timestamp: Date.now(),
    trace: { traceId: "trace", spanId: `span-${id}` },
  }) as TraceEvent;

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

describe("createBatchExporter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes overlapping flush triggers into one in-flight sender", async () => {
    const eventBus = createEventBus();
    const firstSend = createDeferred();
    let inFlight = 0;
    let maxInFlight = 0;
    const sentBatches: number[][] = [];

    const disable = createBatchExporter<number>({
      eventBus,
      batchSize: 1,
      flushInterval: 60_000,
      filter: () => true,
      transform: (event) => Number(event.trace.spanId.replace("span-", "")),
      send: async (batch) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        sentBatches.push(batch);
        if (sentBatches.length === 1) {
          await firstSend.promise;
        }
        inFlight--;
      },
    });

    eventBus.emit(createEvent(1));
    eventBus.emit(createEvent(2));

    await Promise.resolve();

    expect(sentBatches).toEqual([[1]]);
    expect(maxInFlight).toBe(1);

    firstSend.resolve();
    await disable();

    expect(sentBatches).toEqual([[1], [2]]);
    expect(maxInFlight).toBe(1);
  });

  it("drops oldest events when the queue reaches maxQueueSize", async () => {
    const eventBus = createEventBus();
    const transform = vi.fn((event: TraceEvent) => Number(event.trace.spanId.replace("span-", "")));
    const sentBatches: number[][] = [];

    const disable = createBatchExporter<number>({
      eventBus,
      batchSize: 10,
      flushInterval: 60_000,
      maxQueueSize: 2,
      filter: () => true,
      transform,
      send: async (batch) => {
        sentBatches.push(batch);
      },
    });

    eventBus.emit(createEvent(1));
    eventBus.emit(createEvent(2));
    eventBus.emit(createEvent(3));

    await disable();

    expect(transform).toHaveBeenCalledTimes(3);
    expect(sentBatches).toEqual([[2, 3]]);
  });

  it("flushes only the queue snapshot captured at flush start", async () => {
    const eventBus = createEventBus();
    const firstSend = createDeferred();
    const sentBatches: number[][] = [];

    const disable = createBatchExporter<number>({
      eventBus,
      batchSize: 1,
      flushInterval: 60_000,
      filter: () => true,
      transform: (event) => Number(event.trace.spanId.replace("span-", "")),
      send: async (batch) => {
        sentBatches.push(batch);
        if (sentBatches.length === 1) {
          eventBus.emit(createEvent(2));
          await firstSend.promise;
        }
      },
    });

    eventBus.emit(createEvent(1));
    await Promise.resolve();

    expect(sentBatches).toEqual([[1]]);

    firstSend.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sentBatches).toEqual([[1]]);

    await disable();

    expect(sentBatches).toEqual([[1], [2]]);
  });

  it("falls back when numeric queue options are invalid", async () => {
    const eventBus = createEventBus();
    const sentBatches: number[][] = [];

    const disable = createBatchExporter<number>({
      eventBus,
      batchSize: Number.NaN,
      flushInterval: 60_000,
      maxQueueSize: Number.NaN,
      filter: () => true,
      transform: (event) => Number(event.trace.spanId.replace("span-", "")),
      send: async (batch) => {
        sentBatches.push(batch);
      },
    });

    eventBus.emit(createEvent(1));
    eventBus.emit(createEvent(2));

    await disable();

    expect(sentBatches).toEqual([[1, 2]]);
  });

  it("skips nullish transforms and expands array transforms", async () => {
    const eventBus = createEventBus();
    const sentBatches: number[][] = [];

    const disable = createBatchExporter<number>({
      eventBus,
      batchSize: 10,
      flushInterval: 60_000,
      transform: (event) => {
        const id = Number(event.trace.spanId.replace("span-", ""));
        if (id === 1) return undefined;
        return [id, id + 10];
      },
      send: async (batch) => {
        sentBatches.push(batch);
      },
    });

    eventBus.emit(createEvent(1));
    eventBus.emit(createEvent(2));

    await disable();

    expect(sentBatches).toEqual([[2, 12]]);
  });

  it("waits for async transforms before final disable flush", async () => {
    const eventBus = createEventBus();
    const transformReady = createDeferred();
    const sentBatches: number[][] = [];

    const disable = createBatchExporter<number>({
      eventBus,
      batchSize: 10,
      flushInterval: 60_000,
      transform: async (event) => {
        await transformReady.promise;
        return Number(event.trace.spanId.replace("span-", ""));
      },
      send: async (batch) => {
        sentBatches.push(batch);
      },
    });

    eventBus.emit(createEvent(1));

    const disabled = disable();
    await Promise.resolve();

    expect(sentBatches).toEqual([]);

    transformReady.resolve();
    await disabled;

    expect(sentBatches).toEqual([[1]]);
  });

  it("preserves emit order when async transforms resolve out of order", async () => {
    const eventBus = createEventBus();
    const firstTransformReady = createDeferred();
    const sentBatches: number[][] = [];

    const disable = createBatchExporter<number>({
      eventBus,
      batchSize: 10,
      flushInterval: 60_000,
      transform: async (event) => {
        const id = Number(event.trace.spanId.replace("span-", ""));
        if (id === 1) {
          await firstTransformReady.promise;
        }
        return id;
      },
      send: async (batch) => {
        sentBatches.push(batch);
      },
    });

    eventBus.emit(createEvent(1));
    eventBus.emit(createEvent(2));

    await Promise.resolve();
    await Promise.resolve();

    expect(sentBatches).toEqual([]);

    firstTransformReady.resolve();
    await disable();

    expect(sentBatches).toEqual([[1, 2]]);
  });
});
