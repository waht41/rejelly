/**
 * RunWith Tests
 *
 * Tests for runWith function.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMockModel, createTestAgent } from "../../testing/helpers";
import { getCurrentContextSafe } from "../context/accessor";
import { ModelRegistryNotFoundError } from "../domain/errors";
import {
  EVENTS,
  type InstrumentOpEndEvent,
  TRACE_EVENT_SCHEMA_VERSION,
  type TraceEvent,
} from "../domain/events";
import { createAgent } from "../engine/agent";
import { reborn } from "../engine/flow/reborn";
import { instrument } from "../engine/instrument";
import { expectResource } from "../facade/expect/resource";
import { runWith } from "../facade/run";
import { getGlobalEventBus, resetEventBus } from "../observability/event-bus";
import { promptAgent } from "../policy/prompt-schema";
import { dumpSnapshot } from "../snapshot/dump";

describe("runWith", () => {
  beforeEach(() => {
    resetEventBus();
  });

  afterEach(() => {
    resetEventBus();
  });

  describe("basic functionality", () => {
    it("should run function without snapshot", async () => {
      const result = await runWith(async () => {
        return "test result";
      });

      expect(result).toBe("test result");
    });

    it("should run function with initialProps", async () => {
      const result = await runWith(
        async (props: { value: string }) => {
          return `result: ${props.value}`;
        },
        { initialProps: { value: "test" } },
      );

      expect(result).toBe("result: test");
    });

    it("should link injected signal to root context", async () => {
      const ac = new AbortController();
      await runWith(
        async () => {
          const ctx = getCurrentContextSafe();
          expect(ctx?.signal.aborted).toBe(false);
          ac.abort("cancel");
          expect(ctx?.signal.aborted).toBe(true);
        },
        { signal: ac.signal },
      );
    });
  });

  describe("modelRegistry", () => {
    it("should resolve agent model from runWith modelRegistry when model is string id", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "from-registry" });

      const schema = z.object({ result: z.string() });
      const agent = createAgent({
        id: "registry_agent",
        model: "expensive-model-id",
        handler: async () => {
          return await promptAgent(schema);
        },
      });

      const result = await runWith(
        async () => {
          return await agent({});
        },
        {
          modelRegistry: {
            "expensive-model-id": mock.adapter,
          },
        },
      );

      expect(result).toEqual({ result: "from-registry" });
    });

    it("should inherit shared.modelRegistry so nested agents can use model string id", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "nested-ok" });

      const schema = z.object({ result: z.string() });
      const childAgent = createAgent({
        id: "child_registry_agent",
        model: "shared-model",
        handler: async () => {
          return await promptAgent(schema);
        },
      });
      const parentAgent = createAgent({
        id: "parent_registry_agent",
        model: "shared-model",
        handler: async () => {
          return await childAgent({});
        },
      });

      const result = await runWith(
        async () => {
          return await parentAgent({});
        },
        {
          modelRegistry: {
            "shared-model": mock.adapter,
          },
        },
      );

      expect(result).toEqual({ result: "nested-ok" });
    });

    it("should throw ModelRegistryNotFoundError when model string id is not in registry", async () => {
      const agent = createAgent({
        id: "missing_registry_agent",
        model: "missing-id",
        handler: async () => ({ done: true }),
      });

      const err = await runWith(async () => await agent({}), { modelRegistry: {} }).catch((e) => e);

      expect(err).toBeInstanceOf(ModelRegistryNotFoundError);
      expect(err.modelId).toBe("missing-id");
      expect(err.agentId).toBe("missing_registry_agent");
      expect(err.registeredIds).toEqual([]);
    });

    it("should include registeredIds in error when registry has other ids", async () => {
      const mock = createMockModel();
      const agent = createAgent({
        id: "wrong_id_agent",
        model: "nonexistent",
        handler: async () => ({ done: true }),
      });

      const err = await runWith(async () => await agent({}), {
        modelRegistry: {
          "expensive-model-id": mock.adapter,
        },
      }).catch((e) => e);

      expect(err).toBeInstanceOf(ModelRegistryNotFoundError);
      expect(err.modelId).toBe("nonexistent");
      expect(err.agentId).toBe("wrong_id_agent");
      expect(err.registeredIds).toEqual(["expensive-model-id"]);
    });

    it("should support model as ModelAdapter when runWith has modelRegistry (unchanged)", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "direct-adapter" });

      const schema = z.object({ result: z.string() });
      const agent = createAgent({
        id: "direct_model_agent",
        model: mock.adapter,
        handler: async () => {
          return await promptAgent(schema);
        },
      });

      const result = await runWith(
        async () => {
          return await agent({});
        },
        {
          modelRegistry: {
            "other-id": createMockModel().adapter,
          },
        },
      );

      expect(result).toEqual({ result: "direct-adapter" });
    });
  });

  describe("providers with snapshot", () => {
    it("keeps root-seeded providers available when a snapshot is restored", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let savedSnapshot: any = null;
      const sharedStore = new Map<string, unknown>();

      const agent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        behavior: async () => {
          const store = expectResource<Map<string, unknown>>("store");
          store.set("snapshot_data", { value: "updated" });
          savedSnapshot = dumpSnapshot();
          return { done: true };
        },
      });

      await runWith(
        async () => {
          return await agent({});
        },
        { providers: { store: sharedStore } },
      );

      expect(savedSnapshot).toBeDefined();

      let restoredValue: any;
      await runWith(
        async () => {
          const store = expectResource<Map<string, unknown>>("store");
          restoredValue = store.get("snapshot_data");
          return { done: true };
        },
        {
          snapshot: savedSnapshot,
          providers: { store: sharedStore },
        },
      );

      expect(restoredValue).toEqual({ value: "updated" });
    });
  });

  describe("reborn trace context", () => {
    it("should keep same traceId but change spanId after reborn", async () => {
      const eventBus = getGlobalEventBus();
      const events: TraceEvent[] = [];

      eventBus.subscribe("*", (event) => {
        events.push(event);
      });

      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let runCount = 0;

      const agent = createAgent({
        id: "reborn_agent",
        model: mock.adapter,
        handler: async () => {
          runCount++;
          if (runCount === 1) {
            return reborn();
          }
          return { done: true };
        },
      });

      await runWith(async () => {
        return await agent({});
      });

      // Get relevant events
      const agentStarts = events.filter((e) => e.type === EVENTS.AGENT_START);
      const agentReborns = events.filter((e) => e.type === EVENTS.AGENT_REBORN);
      const generationStarts = events.filter((e) => e.type === EVENTS.GENERATION_START);

      // Should have 1 agent:start, 1 agent:reborn, 2 generation:start (initial + after reborn)
      expect(agentStarts.length).toBe(1);
      expect(agentReborns.length).toBe(1);
      expect(generationStarts.length).toBe(2);

      // Get traceId from agent:start
      const agentStartTraceId = agentStarts[0].trace.traceId;
      const agentStartSpanId = agentStarts[0].trace.spanId;

      // Get traceId from agent:reborn
      const agentRebornTraceId = agentReborns[0].trace.traceId;
      const agentRebornParentSpanId = agentReborns[0].trace.parentSpanId;

      // Get generation spanIds
      const firstGenerationSpanId = generationStarts[0].trace.spanId;
      const secondGenerationSpanId = generationStarts[1].trace.spanId;

      // Verify traceId remains the same across all events
      expect(agentRebornTraceId).toBe(agentStartTraceId);
      expect(generationStarts[0].trace.traceId).toBe(agentStartTraceId);
      expect(generationStarts[1].trace.traceId).toBe(agentStartTraceId);

      // Verify agentReborn, should be child span of its generation
      expect(agentRebornParentSpanId).toBe(firstGenerationSpanId);

      // Verify generation spanIds are different (each generation gets new spanId)
      expect(firstGenerationSpanId).not.toBe(secondGenerationSpanId);

      // Verify both generations have agent spanId as parent
      expect(generationStarts[0].trace.parentSpanId).toBe(agentStartSpanId);
      expect(generationStarts[1].trace.parentSpanId).toBe(agentStartSpanId);
    });
  });

  describe("providers (root seeding)", () => {
    it("a root-seeded provider is retrievable via expectResource in the root fn", async () => {
      const pool = { id: "pool-1" };

      const got = await runWith(
        async () => {
          return expectResource<typeof pool>("db");
        },
        { providers: { db: pool } },
      );

      expect(got).toBe(pool);
    });

    it("a root-seeded provider is resolved by a child agent through the parent chain", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const pool = { id: "pool-2" };
      let seen: unknown;

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          seen = expectResource<typeof pool>("db");
          return { done: true };
        },
      });

      await runWith(async () => await ChildAgent({}), { providers: { db: pool } });

      expect(seen).toBe(pool);
    });

    it("surfaces seeded provider keys on the runWith:start event", async () => {
      const eventBus = getGlobalEventBus();
      const events: TraceEvent[] = [];
      eventBus.subscribe("*", (event) => events.push(event));

      await runWith(async () => "ok", {
        providers: { db: {}, cache: {} },
      });

      const start = events.find((e) => e.type === EVENTS.RUN_WITH_START) as
        | { dependencies: { registeredProviders?: string[] } }
        | undefined;
      expect(start?.dependencies.registeredProviders).toEqual(["db", "cache"]);
    });

    it("stamps trace events with the wire schema version", async () => {
      const eventBus = getGlobalEventBus();
      const events: TraceEvent[] = [];
      eventBus.subscribe("*", (event) => events.push(event));

      await runWith(async () => "ok");

      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.schemaVersion === TRACE_EVENT_SCHEMA_VERSION)).toBe(
        true,
      );
    });

    it("an instrumented provider emits instrument:op end-to-end and returns the value", async () => {
      const eventBus = getGlobalEventBus();
      const events: TraceEvent[] = [];
      eventBus.subscribe("*", (event) => events.push(event));

      const client = {
        async get(key: string) {
          return `value:${key}`;
        },
      };
      const tracked = instrument(client, {
        name: "redis",
        ops: ["get"],
        derive: {
          call: ({ args: [key] }) => ({ key }),
        },
      });

      const result = await runWith(
        async () => {
          const db = expectResource<typeof tracked>("db");
          return await db.get("k1");
        },
        { providers: { db: tracked } },
      );

      expect(result).toBe("value:k1");

      const ends = events.filter(
        (e): e is InstrumentOpEndEvent => e.type === EVENTS.INSTRUMENT_OP_END,
      );
      expect(ends).toHaveLength(1);
      expect(ends[0].name).toBe("redis");
      expect(ends[0].operation).toBe("get");
      expect(ends[0].success).toBe(true);
      expect(ends[0].trace.attributes).toEqual({ key: "k1" });
    });
  });
});
