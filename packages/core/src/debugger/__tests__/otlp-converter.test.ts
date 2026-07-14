import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENTS, type TraceEvent } from "../../core/domain/events";
import { logger } from "../../core/shared/logger/instance";
import { eventToOTLPSpan, isPointEvent, type OTLPAttribute } from "../otlp-converter";

/** Find an OTLP attribute by exact key. */
function attr(attributes: OTLPAttribute[], key: string): OTLPAttribute | undefined {
  return attributes.find((a) => a.key === key);
}

/** Minimal custom:span:end event with a trace context. */
function customSpanEnd(
  traceAttributes?: Record<string, unknown>,
  extra?: Partial<TraceEvent>,
): TraceEvent {
  return {
    type: EVENTS.CUSTOM_SPAN_END,
    trace: {
      traceId: "abc-123",
      spanId: "s1",
      parentSpanId: "s0",
      ...(traceAttributes ? { attributes: traceAttributes } : {}),
    },
    timestamp: 1_700_000_000_000,
    agentId: "agent_x",
    name: "step4-write",
    duration: 50,
    success: true,
    ...extra,
  } as TraceEvent;
}

describe("otlp-converter: trace.attributes promotion (#0)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("promotes trace.attributes verbatim into span attributes (regression: previously dropped)", () => {
    const span = eventToOTLPSpan(customSpanEnd({ userId: "u_1", retryCount: 3, cacheHit: true }), {
      realtime: false,
    });

    // The whole point of #0: these used to be silently dropped.
    expect(attr(span.attributes, "userId")).toEqual({
      key: "userId",
      value: { stringValue: "u_1" },
    });
    // Type fidelity: integers -> intValue, booleans -> boolValue.
    expect(attr(span.attributes, "retryCount")).toEqual({
      key: "retryCount",
      value: { intValue: "3" },
    });
    expect(attr(span.attributes, "cacheHit")).toEqual({
      key: "cacheHit",
      value: { boolValue: true },
    });
  });

  it("keeps user keys verbatim (no rejelly.event./prefix mangling)", () => {
    const span = eventToOTLPSpan(customSpanEnd({ region: "eu" }), { realtime: false });
    expect(attr(span.attributes, "region")).toBeDefined();
    expect(attr(span.attributes, "rejelly.event.region")).toBeUndefined();
  });

  it("stringifies nested object values (OTLP has no nested attribute values)", () => {
    const span = eventToOTLPSpan(customSpanEnd({ ctx: { a: 1, b: "x" } }), { realtime: false });
    expect(attr(span.attributes, "ctx")).toEqual({
      key: "ctx",
      value: { stringValue: JSON.stringify({ a: 1, b: "x" }) },
    });
  });

  it("skips reserved-prefix keys and warns, never shadowing framework attributes", () => {
    const span = eventToOTLPSpan(
      customSpanEnd({ "rejelly.span_type": "hijacked", "rejelly.agent.id": "evil", ok: 1 }),
      { realtime: false },
    );

    // Framework attribute is intact (the genuine one, not the user's).
    expect(attr(span.attributes, "rejelly.span_type")).toEqual({
      key: "rejelly.span_type",
      value: { stringValue: "custom" },
    });
    expect(attr(span.attributes, "rejelly.agent.id")).toEqual({
      key: "rejelly.agent.id",
      value: { stringValue: "agent_x" },
    });
    // Non-reserved key still gets through.
    expect(attr(span.attributes, "ok")).toBeDefined();
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when trace carries no attributes", () => {
    const span = eventToOTLPSpan(customSpanEnd(), { realtime: false });
    // Framework attributes still present; no user keys, no warnings.
    expect(attr(span.attributes, "rejelly.span_type")).toBeDefined();
    expect(attr(span.attributes, "userId")).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("accepts fractional millisecond durations from performance timers", () => {
    const durationMs = 3902.8755;
    const span = eventToOTLPSpan(customSpanEnd(undefined, { duration: durationMs }), {
      realtime: false,
    });

    expect(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)).toBe(
      BigInt(Math.round(durationMs * 1_000_000)),
    );
  });

  it("classifies non start/end events without duration as point events", () => {
    const rebornEvent = {
      type: EVENTS.AGENT_REBORN,
      trace: {
        traceId: "abc-123",
        spanId: "reborn-1",
        parentSpanId: "s1",
      },
      timestamp: 1_700_000_000_000,
      agentId: "agent_x",
      generationId: 0,
    } as TraceEvent;

    expect(isPointEvent(customSpanEnd())).toBe(false);
    expect(isPointEvent(rebornEvent)).toBe(true);
    expect(
      isPointEvent(
        customSpanEnd(undefined, {
          type: "debugger:extension" as TraceEvent["type"],
          duration: 10,
        }),
      ),
    ).toBe(false);
  });
});
