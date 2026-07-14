/**
 * Instrument Tests
 *
 * Tests for the `instrument()` call-level tracing factory:
 * - traced methods emit instrument:op start/end (success + error paths)
 * - derive controls recorded meta; raw args/values are never recorded
 * - non-listed members pass through untouched and emit nothing
 * - no-op (and value-preserving) when no trace/context is active
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TraceEvent } from "../domain/events";
import { EVENTS, type InstrumentOpEndEvent, type InstrumentOpStartEvent } from "../domain/events";
import { instrument } from "../engine/instrument";
import { runWith } from "../facade/run";
import { getGlobalEventBus, resetEventBus } from "../observability/event-bus";

interface FakeClient {
  calls: string[];
  get(key: string): Promise<string>;
  boom(): Promise<never>;
  plain(x: number): number;
}

function makeClient(): FakeClient {
  return {
    calls: [],
    async get(key: string) {
      this.calls.push(`get:${key}`);
      return `value:${key}`;
    },
    async boom() {
      throw new Error("kaboom");
    },
    plain(x: number) {
      return x + 1;
    },
  };
}

function captureEvents(): TraceEvent[] {
  const events: TraceEvent[] = [];
  getGlobalEventBus().subscribe("*", (e) => events.push(e));
  return events;
}

const startsOf = (events: TraceEvent[]) =>
  events.filter((e): e is InstrumentOpStartEvent => e.type === EVENTS.INSTRUMENT_OP_START);
const endsOf = (events: TraceEvent[]) =>
  events.filter((e): e is InstrumentOpEndEvent => e.type === EVENTS.INSTRUMENT_OP_END);

describe("instrument", () => {
  beforeEach(() => resetEventBus());
  afterEach(() => resetEventBus());

  it("emits start/end for a traced method and preserves the return value", async () => {
    const events = captureEvents();
    const client = makeClient();

    const result = await runWith(async () => {
      const db = instrument(client, { name: "redis", ops: ["get"] });
      return await db.get("k1");
    });

    expect(result).toBe("value:k1");
    // underlying method actually ran (this binding preserved)
    expect(client.calls).toEqual(["get:k1"]);

    const starts = startsOf(events);
    const ends = endsOf(events);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);

    expect(starts[0].name).toBe("redis");
    expect(starts[0].operation).toBe("get");

    expect(ends[0].name).toBe("redis");
    expect(ends[0].operation).toBe("get");
    expect(ends[0].success).toBe(true);
    expect(typeof ends[0].duration).toBe("number");
    expect(ends[0].duration).toBeGreaterThanOrEqual(0);
    expect(ends[0]).not.toHaveProperty("error");
  });

  it("records derived call meta but never the raw args or the value", async () => {
    const events = captureEvents();

    await runWith(async () => {
      const db = instrument(makeClient(), {
        name: "redis",
        ops: ["get"],
        derive: {
          call: ({ operation, args: [key] }) => ({ op: operation, key }),
        },
      });
      return await db.get("secret-key");
    });

    const start = startsOf(events)[0];
    const end = endsOf(events)[0];

    expect(start.trace.attributes).toEqual({ op: "get", key: "secret-key" });
    expect(end.trace.attributes).toEqual({ op: "get", key: "secret-key" });

    // The raw value / args must not leak into the event payload.
    for (const e of [start, end]) {
      expect(e).not.toHaveProperty("value");
      expect(e).not.toHaveProperty("args");
    }
  });

  it("merges derived result meta into the successful end event", async () => {
    const events = captureEvents();

    await runWith(async () => {
      const db = instrument(makeClient(), {
        name: "redis",
        ops: ["get"],
        derive: {
          call: ({ name, operation, args }) => ({ name, op: operation, key: args[0] }),
          result: ({ success, result, duration }) => ({
            successSeen: success,
            hit: result != null,
            resultType: typeof result,
            timed: duration >= 0,
          }),
        },
      });
      return await db.get("k3");
    });

    const start = startsOf(events)[0];
    const end = endsOf(events)[0];

    expect(start.trace.attributes).toEqual({ name: "redis", op: "get", key: "k3" });
    expect(end.success).toBe(true);
    expect(end.trace.attributes).toEqual({
      name: "redis",
      op: "get",
      key: "k3",
      successSeen: true,
      hit: true,
      resultType: "string",
      timed: true,
    });
  });

  it("ignores call derive failures and preserves the operation result", async () => {
    const events = captureEvents();

    const result = await runWith(async () => {
      const db = instrument(makeClient(), {
        name: "redis",
        ops: ["get"],
        derive: {
          call: () => {
            throw new Error("derive call failed");
          },
          result: () => ({ derived: true }),
        },
      });
      return await db.get("k4");
    });

    expect(result).toBe("value:k4");

    const start = startsOf(events)[0];
    const end = endsOf(events)[0];

    expect(start.trace.attributes).toBeUndefined();
    expect(end.success).toBe(true);
    expect(end.trace.attributes).toEqual({ derived: true });
  });

  it("ignores result derive failures and preserves the operation result", async () => {
    const events = captureEvents();

    const result = await runWith(async () => {
      const db = instrument(makeClient(), {
        name: "redis",
        ops: ["get"],
        derive: {
          call: () => ({ phase: "call" }),
          result: () => {
            throw new Error("derive result failed");
          },
        },
      });
      return await db.get("k5");
    });

    expect(result).toBe("value:k5");

    const end = endsOf(events)[0];

    expect(end.success).toBe(true);
    expect(end.trace.attributes).toEqual({ phase: "call" });
  });

  it("emits success:false with error info and rethrows on failure", async () => {
    const events = captureEvents();

    await expect(
      runWith(async () => {
        const db = instrument(makeClient(), { name: "redis", ops: ["boom"] });
        return await db.boom();
      }),
    ).rejects.toThrow("kaboom");

    const ends = endsOf(events);
    expect(ends).toHaveLength(1);
    expect(ends[0].operation).toBe("boom");
    expect(ends[0].success).toBe(false);
    expect(ends[0].error?.message).toContain("kaboom");
  });

  it("merges derived error meta into the failed end event", async () => {
    const events = captureEvents();

    await expect(
      runWith(async () => {
        const db = instrument(makeClient(), {
          name: "redis",
          ops: ["boom"],
          derive: {
            call: ({ operation }) => ({ op: operation, phase: "call" }),
            error: ({ success, error, duration }) => ({
              successSeen: success,
              phase: "error",
              errorName: error instanceof Error ? error.name : "unknown",
              timed: duration >= 0,
            }),
          },
        });
        return await db.boom();
      }),
    ).rejects.toThrow("kaboom");

    const end = endsOf(events)[0];

    expect(end.success).toBe(false);
    expect(end.trace.attributes).toEqual({
      op: "boom",
      phase: "error",
      successSeen: false,
      errorName: "Error",
      timed: true,
    });
    expect(end.error?.message).toContain("kaboom");
  });

  it("ignores error derive failures and rethrows the original operation error", async () => {
    const events = captureEvents();

    await expect(
      runWith(async () => {
        const db = instrument(makeClient(), {
          name: "redis",
          ops: ["boom"],
          derive: {
            call: () => ({ phase: "call" }),
            error: () => {
              throw new Error("derive error failed");
            },
          },
        });
        return await db.boom();
      }),
    ).rejects.toThrow("kaboom");

    const end = endsOf(events)[0];

    expect(end.success).toBe(false);
    expect(end.trace.attributes).toEqual({ phase: "call" });
    expect(end.error?.message).toContain("kaboom");
  });

  it("passes non-listed members through untouched and emits nothing for them", async () => {
    const events = captureEvents();
    const client = makeClient();

    const result = await runWith(async () => {
      const db = instrument(client, { name: "redis", ops: ["get"] });
      // plain() is not in ops: returned as-is, stays synchronous
      return db.plain(41);
    });

    expect(result).toBe(42);
    // no instrument events for non-listed methods
    expect(startsOf(events)).toHaveLength(0);
    expect(endsOf(events)).toHaveLength(0);
  });

  it("is a no-op (but value-preserving) when no trace/context is active", async () => {
    const events = captureEvents();
    const client = makeClient();
    const db = instrument(client, { name: "redis", ops: ["get"] });

    // called outside any runWith / agent context
    const result = await db.get("k2");

    expect(result).toBe("value:k2");
    expect(client.calls).toEqual(["get:k2"]);
    expect(events).toHaveLength(0);
  });
});
