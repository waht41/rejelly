import { afterEach, describe, expect, it, vi } from "vitest";
import { EVENTS, TRACE_EVENT_SCHEMA_VERSION, type TraceEvent } from "../../core/domain/events";
import { createEventBus } from "../../core/observability/event-bus";
import { enableOTLP } from "../open-telemetry";
import type { OTLPPayload } from "../otlp-converter";

const traceId = "trace-1";

function generationEnd(spanId = "generation-1"): TraceEvent {
  return {
    type: EVENTS.GENERATION_END,
    schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
    trace: { traceId, spanId, parentSpanId: "agent-1" },
    timestamp: 1_700_000_000_100,
    agentId: "agent_x",
    generationId: 0,
    props: {},
    endReason: "return",
    duration: 100,
    success: true,
    draft: {
      calls: [],
      children: [],
      scopeLayers: [],
      toolCount: 0,
      resourceKeys: [],
      validationRan: false,
    },
    memory: {},
  } as TraceEvent;
}

function validationSuccess(): TraceEvent {
  return {
    type: EVENTS.VALIDATION_SUCCESS,
    schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
    trace: { traceId, spanId: "validation-1", parentSpanId: "generation-1" },
    timestamp: 1_700_000_000_050,
    agentId: "agent_x",
    rawText: "ok",
    parserId: "rawText",
    data: "ok",
    success: true,
  } as TraceEvent;
}

function agentReborn(): TraceEvent {
  return {
    type: EVENTS.AGENT_REBORN,
    schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
    // Reborn carries its own span id; it folds onto its parent (the generation span).
    trace: { traceId, spanId: "reborn-1", parentSpanId: "generation-1" },
    timestamp: 1_700_000_000_090,
    agentId: "agent_x",
    generationId: 0,
    newProps: { userId: "user_123" },
  } as TraceEvent;
}

function sysLog(): TraceEvent {
  return {
    type: EVENTS.SYS_LOG,
    schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
    trace: { traceId, spanId: "generation-1", parentSpanId: "agent-1" },
    timestamp: 1_700_000_000_060,
    agentId: "agent_x",
    level: "info",
    message: "inside generation",
    args: [],
  } as TraceEvent;
}

function exportedPayloads(): OTLPPayload[] {
  const calls = vi.mocked(fetch).mock.calls;
  return calls.map(([, init]) => JSON.parse(String(init?.body)) as OTLPPayload);
}

function exportedSpans(payload: OTLPPayload) {
  return payload.resourceSpans[0].scopeSpans[0].spans;
}

describe("enableOTLP", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("attaches point events to their parent span instead of exporting zero-duration spans", async () => {
    const eventBus = createEventBus();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const disable = enableOTLP({
      endpoint: "http://localhost:4318/v1/traces",
      eventBus,
      batchSize: 10,
      flushInterval: 60_000,
      registerShutdown: false,
    });

    eventBus.emit(validationSuccess());
    eventBus.emit(generationEnd());

    await disable();

    const payloads = exportedPayloads();
    expect(payloads).toHaveLength(1);

    const spans = exportedSpans(payloads[0]);
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("generation");
    expect(spans[0].events?.map((event) => event.name)).toEqual([EVENTS.VALIDATION_SUCCESS]);
  });

  it("folds agent:reborn onto its generation span when emitted before generation:end", async () => {
    const eventBus = createEventBus();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const disable = enableOTLP({
      endpoint: "http://localhost:4318/v1/traces",
      eventBus,
      batchSize: 10,
      flushInterval: 60_000,
      registerShutdown: false,
    });

    // Order matches agent.ts: reborn point event is emitted before its generation:end.
    eventBus.emit(agentReborn());
    eventBus.emit(generationEnd());

    await disable();

    const spans = exportedSpans(exportedPayloads()[0]);
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("generation");
    expect(spans[0].events?.map((event) => event.name)).toEqual([EVENTS.AGENT_REBORN]);
  });

  it("drops a point event emitted after its target span is exported (ordering contract)", async () => {
    const eventBus = createEventBus();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const disable = enableOTLP({
      endpoint: "http://localhost:4318/v1/traces",
      eventBus,
      batchSize: 10,
      flushInterval: 60_000,
      registerShutdown: false,
    });

    // Violates the contract: the target span's :end is exported before the point event arrives.
    eventBus.emit(generationEnd());
    eventBus.emit(agentReborn());

    await disable();

    const spans = exportedSpans(exportedPayloads()[0]);
    expect(spans).toHaveLength(1);
    expect(spans[0].events ?? []).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("point event(s) without exported parent span"),
    );
  });

  it("attaches sys:log to the current span id it reuses", async () => {
    const eventBus = createEventBus();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const disable = enableOTLP({
      endpoint: "http://localhost:4318/v1/traces",
      eventBus,
      batchSize: 10,
      flushInterval: 60_000,
      registerShutdown: false,
    });

    eventBus.emit(sysLog());
    eventBus.emit(generationEnd());

    await disable();

    const spans = exportedSpans(exportedPayloads()[0]);
    expect(spans).toHaveLength(1);
    expect(spans[0].events?.map((event) => event.name)).toEqual([EVENTS.SYS_LOG]);
    expect(spans[0].events?.[0].attributes).toContainEqual({
      key: "rejelly.event.message",
      value: { stringValue: "inside generation" },
    });
  });

  it("applies convert before folding point events into their parent span", async () => {
    const eventBus = createEventBus();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const disable = enableOTLP({
      endpoint: "http://localhost:4318/v1/traces",
      eventBus,
      batchSize: 10,
      flushInterval: 60_000,
      registerShutdown: false,
      convert: async (event) =>
        event.type === EVENTS.SYS_LOG
          ? {
              ...event,
              message: "inside generation [redacted]",
            }
          : event,
    });

    eventBus.emit(sysLog());
    eventBus.emit(generationEnd());

    await disable();

    const spans = exportedSpans(exportedPayloads()[0]);
    expect(spans).toHaveLength(1);
    expect(spans[0].events?.[0].attributes).toContainEqual({
      key: "rejelly.event.message",
      value: { stringValue: "inside generation [redacted]" },
    });
  });
});
