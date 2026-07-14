import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENTS, type TraceEvent } from "../domain/events";
import { createAgent } from "../engine/agent";
import { equipTraceAttr } from "../facade/equip/equip";
import { runWith } from "../facade/run";
import { type EventBus, getGlobalEventBus, resetEventBus } from "../observability/event-bus";
import { withSpan } from "../observability/trace";

interface CollectedEvents {
  all: TraceEvent[];
  byType: Map<string, TraceEvent[]>;
}

function createEventCollector(eventBus: EventBus): CollectedEvents {
  const collected: CollectedEvents = {
    all: [],
    byType: new Map(),
  };

  eventBus.subscribe("*", (event) => {
    collected.all.push(event);
    const typeEvents = collected.byType.get(event.type) ?? [];
    typeEvents.push(event);
    collected.byType.set(event.type, typeEvents);
  });

  return collected;
}

describe("equipTraceAttr", () => {
  let eventBus: EventBus;
  let events: CollectedEvents;

  beforeEach(() => {
    resetEventBus();
    eventBus = getGlobalEventBus();
    events = createEventCollector(eventBus);
  });

  afterEach(() => {
    resetEventBus();
  });

  it("defaults to agent target and emits attributes on agent:end only", async () => {
    const agent = createAgent({
      id: "agent_trace_attr",
      handler: async () => {
        equipTraceAttr({ requestId: "req-1" });
        equipTraceAttr({ userId: "u-1", requestId: "req-2" });
        return { ok: true };
      },
    });

    await agent({});

    const generationEnds = events.byType.get(EVENTS.GENERATION_END) ?? [];
    const agentEnds = events.byType.get(EVENTS.AGENT_END) ?? [];

    expect(generationEnds).toHaveLength(1);
    expect(agentEnds).toHaveLength(1);
    expect(generationEnds[0].trace.attributes).toBeUndefined();
    expect(agentEnds[0].trace.attributes).toEqual({ requestId: "req-2", userId: "u-1" });
  });

  it("target local attaches attributes to the current span only", async () => {
    const agent = createAgent({
      id: "local_trace_attr",
      handler: async () => {
        equipTraceAttr({ scope: "agent" });

        await withSpan(
          { name: "local", attributes: { initial: true, scope: "span" } },
          (emitter) => {
            equipTraceAttr({ scope: "local", count: 1 }, { target: "local" });
            emitter?.sysLog({ level: "info", message: "inside local span", args: [] });
          },
        );

        return { ok: true };
      },
    });

    await agent({});

    const logs = events.byType.get(EVENTS.SYS_LOG) ?? [];
    const generationEnds = events.byType.get(EVENTS.GENERATION_END) ?? [];
    const agentEnds = events.byType.get(EVENTS.AGENT_END) ?? [];

    expect(logs).toHaveLength(1);
    expect(logs[0].trace.attributes).toEqual({ initial: true, scope: "local", count: 1 });
    expect(generationEnds[0].trace.attributes).toBeUndefined();
    expect(agentEnds[0].trace.attributes).toEqual({ scope: "agent" });
  });

  it("default agent target still reaches agent events when called under withSpan", async () => {
    const agent = createAgent({
      id: "span_to_agent_trace_attr",
      handler: async () => {
        await withSpan("inner", () => {
          equipTraceAttr({ fromSpan: true });
        });
        return { ok: true };
      },
    });

    await agent({});

    const generationEnds = events.byType.get(EVENTS.GENERATION_END) ?? [];
    const agentEnds = events.byType.get(EVENTS.AGENT_END) ?? [];

    expect(generationEnds).toHaveLength(1);
    expect(agentEnds).toHaveLength(1);
    expect(generationEnds[0].trace.attributes).toBeUndefined();
    expect(agentEnds[0].trace.attributes).toEqual({ fromSpan: true });
  });

  it("warns when default agent target is called directly under runWith root context", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await runWith(async () => {
        equipTraceAttr({ rootOnly: true });
        return { ok: true };
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("target 'agent' was called in runWith root context"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("validates serializable values for both targets", async () => {
    const agent = createAgent({
      id: "invalid_trace_attr",
      handler: async () => {
        await withSpan("local", () => {
          expect(() => equipTraceAttr({ invalid: () => "nope" }, { target: "local" })).toThrow(
            TypeError,
          );
        });
        expect(() => equipTraceAttr({ invalid: new Date() })).toThrow(TypeError);
        return { ok: true };
      },
    });

    await agent({});
  });
});
