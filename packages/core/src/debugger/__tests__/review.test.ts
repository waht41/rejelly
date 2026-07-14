import { afterEach, describe, expect, it, vi } from "vitest";
import { EVENTS, TRACE_EVENT_SCHEMA_VERSION, type TraceEvent } from "../../core/domain/events";
import { createEventBus } from "../../core/observability/event-bus";
import { enableReview } from "../review";

function sysLog(): TraceEvent {
  return {
    type: EVENTS.SYS_LOG,
    schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
    trace: { traceId: "trace-1", spanId: "generation-1", parentSpanId: "agent-1" },
    timestamp: 1_700_000_000_060,
    agentId: "agent_x",
    level: "info",
    message: "user email: ada@example.com",
    args: [],
  } as TraceEvent;
}

describe("enableReview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("applies convert before serializing events without mutating the emitted event", async () => {
    const eventBus = createEventBus();
    const original = sysLog();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const disable = enableReview({
      endpoint: "http://localhost:5789/api/v1/traces",
      eventBus,
      batchSize: 10,
      flushInterval: 60_000,
      registerShutdown: false,
      convert: async (event) =>
        event.type === EVENTS.SYS_LOG
          ? {
              ...event,
              message: "user email: [redacted]",
            }
          : event,
    });

    eventBus.emit(original);

    await disable();

    const [, init] = vi.mocked(fetch).mock.calls[0];
    const exportedEvents = JSON.parse(String(init?.body)) as Array<TraceEvent & { _seq: number }>;

    expect(exportedEvents).toHaveLength(1);
    expect(exportedEvents[0]).toMatchObject({
      type: EVENTS.SYS_LOG,
      message: "user email: [redacted]",
      _seq: 0,
    });
    expect(original).toMatchObject({ message: "user email: ada@example.com" });
  });
});
