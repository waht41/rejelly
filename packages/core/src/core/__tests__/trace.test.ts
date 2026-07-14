/**
 * Trace Tests
 *
 * Tests for trace relationship between agents:
 * - Promise.all parallel execution
 * - Pure orchestration agent (no promptAgent)
 * - Sequential agent calls
 * - Nested agent calls
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMockModel, schemas } from "../../testing/helpers";
import { getCurrentContextSafe } from "../context/accessor";
import { isRequiresAgentContextError, RequiresAgentContextError } from "../domain/errors";
import {
  type AgentEndEvent,
  type AgentStartEvent,
  EVENTS,
  type PromptAgentEndEvent,
  type TraceEvent,
} from "../domain/events";
import { createAgent } from "../engine/agent";
import { reborn } from "../engine/flow/reborn";
import { equipInstruction, equipTraceAttr } from "../facade/equip/equip";
import { runWith } from "../facade/run";
import { type EventBus, getGlobalEventBus, resetEventBus } from "../observability/event-bus";
import { withCustomSpan } from "../observability/trace";
import { promptAgent } from "../policy/prompt-schema";

// ============ Test Helpers ============

interface CollectedEvents {
  all: TraceEvent[];
  byType: Map<string, TraceEvent[]>;
  byTraceId: Map<string, TraceEvent[]>;
  byAgentId: Map<string, TraceEvent[]>;
}

/**
 * Create event collector for testing
 */
function createEventCollector(eventBus: EventBus): CollectedEvents {
  const collected: CollectedEvents = {
    all: [],
    byType: new Map(),
    byTraceId: new Map(),
    byAgentId: new Map(),
  };

  eventBus.subscribe("*", (event) => {
    collected.all.push(event);

    // Group by type
    const typeEvents = collected.byType.get(event.type) ?? [];
    typeEvents.push(event);
    collected.byType.set(event.type, typeEvents);

    // Group by traceId
    const traceId = event.trace.traceId;
    const traceEvents = collected.byTraceId.get(traceId) ?? [];
    traceEvents.push(event);
    collected.byTraceId.set(traceId, traceEvents);

    // Group by agentId
    if (event.agentId) {
      const agentEvents = collected.byAgentId.get(event.agentId) ?? [];
      agentEvents.push(event);
      collected.byAgentId.set(event.agentId, agentEvents);
    }
  });

  return collected;
}

/**
 * Find parent-child relationship between events
 */
function _findParentEvent(event: TraceEvent, events: TraceEvent[]): TraceEvent | undefined {
  if (!event.trace.parentSpanId) return undefined;
  return events.find(
    (e) => e.trace.traceId === event.trace.traceId && e.trace.spanId === event.trace.parentSpanId,
  );
}

/**
 * Build trace tree from events
 */
interface TraceNode {
  event: TraceEvent;
  children: TraceNode[];
}

function _buildTraceTree(events: TraceEvent[]): TraceNode[] {
  const roots: TraceNode[] = [];
  const nodeMap = new Map<string, TraceNode>();

  // Create nodes for all events
  for (const event of events) {
    nodeMap.set(event.trace.spanId, { event, children: [] });
  }

  // Build tree structure
  for (const event of events) {
    const node = nodeMap.get(event.trace.spanId)!;
    if (!event.trace.parentSpanId) {
      roots.push(node);
    } else {
      const parent = nodeMap.get(event.trace.parentSpanId);
      if (parent) {
        parent.children.push(node);
      } else {
        // Parent not in current event list, treat as root
        roots.push(node);
      }
    }
  }

  return roots;
}

// ============ Tests ============

describe("withCustomSpan", () => {
  it("should throw RequiresAgentContextError when called at top level (no context)", async () => {
    await expect(
      withCustomSpan("my-span", async (span) => {
        span.setAttribute("key", "value");
        return "ok";
      }),
    ).rejects.toThrow(RequiresAgentContextError);

    const err = await withCustomSpan("x", async () => 1).catch((e) => e);
    expect(isRequiresAgentContextError(err)).toBe(true);
    expect((err as RequiresAgentContextError).apiName).toBe("withCustomSpan");
  });
});

describe("Trace - Basic", () => {
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

  it("single agent emits agent:start and agent:end with same trace", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "single_agent",
      model: mock.adapter,
      maxReborns: 7,
      handler: async () => promptAgent(schemas.simple),
    });

    await agent({});

    // Should have agent:start and agent:end
    const starts = events.byType.get(EVENTS.AGENT_START) ?? [];
    const ends = events.byType.get(EVENTS.AGENT_END) ?? [];

    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);

    // Same traceId and spanId
    expect(starts[0].trace.traceId).toBe(ends[0].trace.traceId);
    expect(starts[0].trace.spanId).toBe(ends[0].trace.spanId);
    expect(starts[0].agentId).toBe("single_agent");
    expect(ends[0].agentId).toBe("single_agent");

    // Resolved reborn cap is exposed on both start and end events
    expect((starts[0] as AgentStartEvent).maxReborns).toBe(7);
    expect((ends[0] as AgentEndEvent).maxReborns).toBe(7);
  });

  it("promptAgent emits promptAgent:start and promptAgent:end events", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "prompt_agent",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    await agent({});

    // Should have promptAgent:start and promptAgent:end
    const promptAgentStarts = events.byType.get(EVENTS.PROMPT_AGENT_START) ?? [];
    const promptAgentEnds = events.byType.get(EVENTS.PROMPT_AGENT_END) ?? [];

    expect(promptAgentStarts.length).toBe(1);
    expect(promptAgentEnds.length).toBe(1);

    // Same traceId
    expect(promptAgentStarts[0].trace.traceId).toBe(promptAgentEnds[0].trace.traceId);

    // End event should have success and duration
    const endEvent = promptAgentEnds[0] as PromptAgentEndEvent;
    expect(endEvent.success).toBe(true);
    expect(endEvent.duration).toBeGreaterThanOrEqual(0);
    expect(endEvent.totalSteps).toBe(1);
    expect(endEvent.result).toEqual({ result: "ok" });
  });

  it("promptAgent emits prompt events within agent trace", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "prompt_agent",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    await agent({});

    // Should have turn and prompt events
    const turnStarts = events.byType.get(EVENTS.TURN_START) ?? [];
    const turnEnds = events.byType.get(EVENTS.TURN_END) ?? [];
    const modelCallStarts = events.byType.get(EVENTS.MODEL_CALL_START) ?? [];
    const modelCallEnds = events.byType.get(EVENTS.MODEL_CALL_END) ?? [];

    expect(turnStarts.length).toBeGreaterThanOrEqual(1);
    expect(turnEnds.length).toBeGreaterThanOrEqual(1);
    expect(modelCallStarts.length).toBeGreaterThanOrEqual(1);
    expect(modelCallEnds.length).toBeGreaterThanOrEqual(1);

    // All should share same traceId
    const traceId = events.all[0].trace.traceId;
    expect(events.all.every((e) => e.trace.traceId === traceId)).toBe(true);
  });

  it("promptAgent:end has error info when validation fails", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ wrong: "type" }); // Won't match schema

    const agent = createAgent({
      id: "failing_agent",
      model: mock.adapter,
      maxRetries: 0, // No retries
      handler: async () => promptAgent(schemas.simple),
    });

    await expect(agent({})).rejects.toThrow();

    const promptAgentEnds = events.byType.get(EVENTS.PROMPT_AGENT_END) ?? [];
    expect(promptAgentEnds.length).toBe(1);

    const endEvent = promptAgentEnds[0] as any;
    expect(endEvent.success).toBe(false);
    expect(endEvent.error).toBeDefined();
  });
});

describe("Trace - Sequential Agents", () => {
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

  it("sequential child agents share same traceId with parent", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    // Child agent
    const ChildAgent = createAgent({
      id: "child_agent",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    // Parent agent that calls child sequentially twice
    const ParentAgent = createAgent({
      id: "parent_agent",
      model: mock.adapter,
      handler: async () => {
        const result1 = await ChildAgent({});
        const result2 = await ChildAgent({});
        return { results: [result1, result2] };
      },
    });

    await ParentAgent({});

    // All events should share same traceId
    const traceIds = new Set(events.all.map((e) => e.trace.traceId));
    expect(traceIds.size).toBe(1);

    // Should have 3 agent:start (1 parent + 2 children)
    const agentStarts = events.byType.get(EVENTS.AGENT_START) ?? [];
    expect(agentStarts.length).toBe(3);

    // Parent agent starts first
    expect(agentStarts[0].agentId).toBe("parent_agent");
    expect(agentStarts[1].agentId).toBe("child_agent");
    expect(agentStarts[2].agentId).toBe("child_agent");
  });

  it("child agent has parent agent as parentSpanId", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const ChildAgent = createAgent({
      id: "child_agent",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    const ParentAgent = createAgent({
      id: "parent_agent",
      model: mock.adapter,
      handler: async () => {
        return await ChildAgent({});
      },
    });

    await ParentAgent({});

    const agentStarts = events.byType.get(EVENTS.AGENT_START) ?? [];
    const _parentStart = agentStarts.find((e) => e.agentId === "parent_agent")!;
    const childStart = agentStarts.find((e) => e.agentId === "child_agent")!;

    // Find parent's generation:start event
    const parentGenerations = events.byType.get(EVENTS.GENERATION_START) ?? [];
    const parentGeneration = parentGenerations.find((e) => e.agentId === "parent_agent")!;

    // Child's parentSpanId should be parent's generation spanId
    expect(childStart.trace.parentSpanId).toBe(parentGeneration.trace.spanId);
  });
});

describe("Trace - Parallel Agents (Promise.all)", () => {
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

  it("parallel child agents share same traceId with parent", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const ChildA = createAgent({
      id: "child_a",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    const ChildB = createAgent({
      id: "child_b",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    const ParentAgent = createAgent({
      id: "parallel_parent",
      model: mock.adapter,
      handler: async () => {
        // Parallel execution
        const [resultA, resultB] = await Promise.all([ChildA({}), ChildB({})]);
        return { a: resultA, b: resultB };
      },
    });

    await ParentAgent({});

    // All events should share same traceId
    const traceIds = new Set(events.all.map((e) => e.trace.traceId));
    expect(traceIds.size).toBe(1);

    // Should have 3 agent:start (1 parent + 2 children)
    const agentStarts = events.byType.get(EVENTS.AGENT_START) ?? [];
    expect(agentStarts.length).toBe(3);

    const agentIds = new Set(agentStarts.map((e) => e.agentId));
    expect(agentIds).toContain("parallel_parent");
    expect(agentIds).toContain("child_a");
    expect(agentIds).toContain("child_b");
  });

  it("parallel children have same parent but different spanIds", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const ChildA = createAgent({
      id: "child_a",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    const ChildB = createAgent({
      id: "child_b",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    const ParentAgent = createAgent({
      id: "parallel_parent",
      model: mock.adapter,
      handler: async () => {
        const [a, b] = await Promise.all([ChildA({}), ChildB({})]);
        return { a, b };
      },
    });

    await ParentAgent({});

    const agentStarts = events.byType.get(EVENTS.AGENT_START) ?? [];
    const _parentStart = agentStarts.find((e) => e.agentId === "parallel_parent")!;
    const childAStart = agentStarts.find((e) => e.agentId === "child_a")!;
    const childBStart = agentStarts.find((e) => e.agentId === "child_b")!;

    // Find parent's generation:start event
    const parentGenerations = events.byType.get(EVENTS.GENERATION_START) ?? [];
    const parentGeneration = parentGenerations.find((e) => e.agentId === "parallel_parent")!;

    // Both children should have parent's generation as parentSpanId
    expect(childAStart.trace.parentSpanId).toBe(parentGeneration.trace.spanId);
    expect(childBStart.trace.parentSpanId).toBe(parentGeneration.trace.spanId);

    // Children should have different spanIds
    expect(childAStart.trace.spanId).not.toBe(childBStart.trace.spanId);
  });

  it("deep parallel nesting maintains correct trace hierarchy", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    // Leaf agents
    const LeafAgent = createAgent({
      id: "leaf_agent",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    // Mid-level agent that calls leaves in parallel
    const MidAgent = createAgent({
      id: "mid_agent",
      model: mock.adapter,
      handler: async () => {
        const [a, b] = await Promise.all([LeafAgent({}), LeafAgent({})]);
        return { a, b };
      },
    });

    // Top-level agent that calls mid agents in parallel
    const TopAgent = createAgent({
      id: "top_agent",
      model: mock.adapter,
      handler: async () => {
        const [m1, m2] = await Promise.all([MidAgent({}), MidAgent({})]);
        return { m1, m2 };
      },
    });

    await TopAgent({});

    // All events should share same traceId
    const traceIds = new Set(events.all.map((e) => e.trace.traceId));
    expect(traceIds.size).toBe(1);

    // Should have 7 agent:start (1 top + 2 mid + 4 leaf)
    const agentStarts = events.byType.get(EVENTS.AGENT_START) ?? [];
    expect(agentStarts.length).toBe(7);

    // Count by agentId
    const topCount = agentStarts.filter((e) => e.agentId === "top_agent").length;
    const midCount = agentStarts.filter((e) => e.agentId === "mid_agent").length;
    const leafCount = agentStarts.filter((e) => e.agentId === "leaf_agent").length;

    expect(topCount).toBe(1);
    expect(midCount).toBe(2);
    expect(leafCount).toBe(4);
  });
});

describe("Trace - Pure Orchestrator Agent (no promptAgent)", () => {
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

  it("pure orchestrator without promptAgent maintains trace", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    // Worker agents that use promptAgent
    const WorkerA = createAgent({
      id: "worker_a",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    const WorkerB = createAgent({
      id: "worker_b",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    // Pure orchestrator - no model, no promptAgent
    const Orchestrator = createAgent({
      id: "orchestrator",
      // No model needed for pure orchestration
      handler: async () => {
        // Step 1: Call WorkerA
        const resultA = await WorkerA({});

        // Step 2: Call WorkerB
        const resultB = await WorkerB({});

        // Pure code orchestration
        return {
          combined: `${resultA.result}-${resultB.result}`,
          count: 2,
        };
      },
    });

    const result = await Orchestrator({});

    expect(result.combined).toBe("ok-ok");
    expect(result.count).toBe(2);

    // All events should share same traceId
    const traceIds = new Set(events.all.map((e) => e.trace.traceId));
    expect(traceIds.size).toBe(1);

    // Should have 3 agent:start
    const agentStarts = events.byType.get(EVENTS.AGENT_START) ?? [];
    expect(agentStarts.length).toBe(3);

    // Orchestrator should be first
    expect(agentStarts[0].agentId).toBe("orchestrator");

    // Workers should have orchestrator's generation as parent
    const _orchestratorStart = agentStarts.find((e) => e.agentId === "orchestrator")!;
    const workerStarts = agentStarts.filter((e) => e.agentId?.startsWith("worker_"));

    // Find orchestrator's generation:start event
    const orchestratorGenerations = events.byType.get(EVENTS.GENERATION_START) ?? [];
    const orchestratorGeneration = orchestratorGenerations.find(
      (e) => e.agentId === "orchestrator",
    )!;

    for (const worker of workerStarts) {
      expect(worker.trace.parentSpanId).toBe(orchestratorGeneration.trace.spanId);
    }
  });

  it("orchestrator with parallel workers", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ value: 1 });

    const ComputeAgent = createAgent({
      id: "compute_agent",
      model: mock.adapter,
      handler: async (props: { multiplier: number }) => {
        equipInstruction(`Multiply by ${props.multiplier}`);
        return promptAgent(z.object({ value: z.number() }));
      },
    });

    // Orchestrator runs multiple workers in parallel, aggregates results
    const MapReduceOrchestrator = createAgent({
      id: "map_reduce_orchestrator",
      handler: async (props: { inputs: number[] }) => {
        // Map phase: parallel
        const results = await Promise.all(props.inputs.map((n) => ComputeAgent({ multiplier: n })));

        // Reduce phase: pure code
        const sum = results.reduce((acc, r) => acc + r.value, 0);
        return { sum, count: results.length };
      },
    });

    const result = await MapReduceOrchestrator({ inputs: [1, 2, 3] });

    expect(result.count).toBe(3);
    expect(result.sum).toBe(3); // Each returns 1, so sum = 3

    // All events should share same traceId
    const traceIds = new Set(events.all.map((e) => e.trace.traceId));
    expect(traceIds.size).toBe(1);

    // 1 orchestrator + 3 compute agents
    const agentStarts = events.byType.get(EVENTS.AGENT_START) ?? [];
    expect(agentStarts.length).toBe(4);
  });

  it("nested orchestrators maintain correct hierarchy", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ data: "result" });

    const LeafWorker = createAgent({
      id: "leaf_worker",
      model: mock.adapter,
      handler: async () => promptAgent(z.object({ data: z.string() })),
    });

    // Level 2 orchestrator
    const Level2Orchestrator = createAgent({
      id: "level2_orchestrator",
      handler: async () => {
        const [a, b] = await Promise.all([LeafWorker({}), LeafWorker({})]);
        return { level2: [a.data, b.data] };
      },
    });

    // Level 1 orchestrator (top)
    const Level1Orchestrator = createAgent({
      id: "level1_orchestrator",
      handler: async () => {
        const r1 = await Level2Orchestrator({});
        const r2 = await Level2Orchestrator({});
        return { level1: [r1.level2, r2.level2] };
      },
    });

    const result = await Level1Orchestrator({});

    expect(result.level1.length).toBe(2);

    // Trace structure:
    // level1_orchestrator
    //   ├── level2_orchestrator (first call)
    //   │   ├── leaf_worker
    //   │   └── leaf_worker
    //   └── level2_orchestrator (second call)
    //       ├── leaf_worker
    //       └── leaf_worker

    const agentStarts = events.byType.get(EVENTS.AGENT_START) ?? [];

    // 1 level1 + 2 level2 + 4 leaf = 7
    expect(agentStarts.length).toBe(7);

    // Verify hierarchy
    const _level1 = agentStarts.find((e) => e.agentId === "level1_orchestrator")!;
    const level2s = agentStarts.filter((e) => e.agentId === "level2_orchestrator");
    const leaves = agentStarts.filter((e) => e.agentId === "leaf_worker");

    // Level2 should have Level1's generation as parent
    const level1Generations = events.byType.get(EVENTS.GENERATION_START) ?? [];
    const level1Generation = level1Generations.find((e) => e.agentId === "level1_orchestrator")!;

    for (const l2 of level2s) {
      expect(l2.trace.parentSpanId).toBe(level1Generation.trace.spanId);
    }

    // Each leaf should have a Level2's generation as parent
    const level2Generations = events.byType.get(EVENTS.GENERATION_START) ?? [];
    for (const leaf of leaves) {
      const parentGeneration = level2Generations.find(
        (gen) =>
          gen.agentId === "level2_orchestrator" && gen.trace.spanId === leaf.trace.parentSpanId,
      );
      expect(parentGeneration).toBeDefined();
    }
  });
});

describe("Trace - Mixed Patterns", () => {
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

  it("complex orchestrator with parallel sub-orchestrators", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ output: "done" });

    // Analyzer agent
    const AnalyzerAgent = createAgent({
      id: "analyzer_agent",
      model: mock.adapter,
      handler: async (props: { text: string }) => {
        equipInstruction(`Analyze: ${props.text}`);
        return promptAgent(z.object({ output: z.string() }));
      },
    });

    // Classifier agent
    const ClassifierAgent = createAgent({
      id: "classifier_agent",
      model: mock.adapter,
      handler: async (props: { text: string }) => {
        equipInstruction(`Classify: ${props.text}`);
        return promptAgent(z.object({ output: z.string() }));
      },
    });

    // Detail extractor agent
    const DetailExtractorAgent = createAgent({
      id: "detail_extractor_agent",
      model: mock.adapter,
      handler: async () => promptAgent(z.object({ output: z.string() })),
    });

    // Planner agent
    const PlannerAgent = createAgent({
      id: "planner_agent",
      model: mock.adapter,
      handler: async () => promptAgent(z.object({ output: z.string() })),
    });

    // Main pipeline orchestrator
    const PipelineOrchestrator = createAgent({
      id: "pipeline_orchestrator",
      handler: async (props: { input: string }) => {
        // Step 1: Parallel - Analyzer + Classifier
        const [analyzerResult, classifierResult] = await Promise.all([
          AnalyzerAgent({ text: props.input }),
          ClassifierAgent({ text: props.input }),
        ]);

        // Step 2: For each item, parallel DetailExtractor + Planner
        const items = ["item1", "item2"]; // Simulated items
        const itemResults = await Promise.all(
          items.map(async (item) => {
            const [detail, plan] = await Promise.all([DetailExtractorAgent({}), PlannerAgent({})]);
            return { item, detail, plan };
          }),
        );

        return {
          analysis: analyzerResult,
          classification: classifierResult,
          itemDetails: itemResults,
        };
      },
    });

    await PipelineOrchestrator({ input: "Sample input" });

    // All events share same traceId
    const traceIds = new Set(events.all.map((e) => e.trace.traceId));
    expect(traceIds.size).toBe(1);

    // Count agents:
    // 1 orchestrator + 1 analyzer + 1 classifier + 2 detail_extractor + 2 planner = 7
    const agentStarts = events.byType.get(EVENTS.AGENT_START) ?? [];
    expect(agentStarts.length).toBe(7);

    // Verify orchestrator is root
    const orchestrator = agentStarts.find((e) => e.agentId === "pipeline_orchestrator")!;
    expect(orchestrator.trace.parentSpanId).toBe(""); // Root has no parent or empty string

    // All other agents should be descendants of orchestrator's generation
    const orchestratorGenerations = events.byType.get(EVENTS.GENERATION_START) ?? [];
    const orchestratorGeneration = orchestratorGenerations.find(
      (e) => e.agentId === "pipeline_orchestrator",
    )!;

    const others = agentStarts.filter((e) => e.agentId !== "pipeline_orchestrator");
    for (const agent of others) {
      // Direct children have orchestrator's generation as parent
      expect(agent.trace.parentSpanId).toBe(orchestratorGeneration.trace.spanId);
    }
  });

  it("agent calling itself recursively maintains trace", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ count: 0 });

    let callCount = 0;

    const RecursiveAgent = createAgent({
      id: "recursive_agent",
      model: mock.adapter,
      handler: async (props: { depth: number }): Promise<{ count: number }> => {
        callCount++;
        if (props.depth <= 0) {
          return await promptAgent(z.object({ count: z.number() }));
        }
        // Recursive call
        const childResult = await RecursiveAgent({ depth: props.depth - 1 });
        return { count: childResult.count + 1 };
      },
    });

    const _result = await RecursiveAgent({ depth: 2 });

    expect(callCount).toBe(3);

    // All events share same traceId
    const traceIds = new Set(events.all.map((e) => e.trace.traceId));
    expect(traceIds.size).toBe(1);

    // 3 agent starts
    const agentStarts = events.byType.get(EVENTS.AGENT_START) ?? [];
    expect(agentStarts.length).toBe(3);

    // Each subsequent call should have previous generation as parent
    const generations = events.byType.get(EVENTS.GENERATION_START) ?? [];
    const generation0 = generations.find((_e, idx) => idx === 0)!;
    const generation1 = generations.find((_e, idx) => idx === 1)!;

    expect(agentStarts[1].trace.parentSpanId).toBe(generation0.trace.spanId);
    expect(agentStarts[2].trace.parentSpanId).toBe(generation1.trace.spanId);
  });
});

describe("Trace - Event Order", () => {
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

  it("agent:start comes before agent:end", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test_agent",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    await agent({});

    const agentEvents = events.all.filter(
      (e) => e.type === EVENTS.AGENT_START || e.type === EVENTS.AGENT_END,
    );

    const startIndex = agentEvents.findIndex((e) => e.type === EVENTS.AGENT_START);
    const endIndex = agentEvents.findIndex((e) => e.type === EVENTS.AGENT_END);

    expect(startIndex).toBeLessThan(endIndex);
  });

  it("child agent events are between parent start and end", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const ChildAgent = createAgent({
      id: "child_agent",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    const ParentAgent = createAgent({
      id: "parent_agent",
      model: mock.adapter,
      handler: async () => {
        return await ChildAgent({});
      },
    });

    await ParentAgent({});

    const agentEvents = events.all.filter(
      (e) => e.type === EVENTS.AGENT_START || e.type === EVENTS.AGENT_END,
    );

    const parentStartIndex = agentEvents.findIndex(
      (e) => e.type === EVENTS.AGENT_START && e.agentId === "parent_agent",
    );
    const parentEndIndex = agentEvents.findIndex(
      (e) => e.type === EVENTS.AGENT_END && e.agentId === "parent_agent",
    );
    const childStartIndex = agentEvents.findIndex(
      (e) => e.type === EVENTS.AGENT_START && e.agentId === "child_agent",
    );
    const childEndIndex = agentEvents.findIndex(
      (e) => e.type === EVENTS.AGENT_END && e.agentId === "child_agent",
    );

    // Parent start < Child start < Child end < Parent end
    expect(parentStartIndex).toBeLessThan(childStartIndex);
    expect(childStartIndex).toBeLessThan(childEndIndex);
    expect(childEndIndex).toBeLessThan(parentEndIndex);
  });

  it("turn events are within prompt span", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test_agent",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    await agent({});

    const turnStarts = events.byType.get(EVENTS.TURN_START) ?? [];
    const _turnEnds = events.byType.get(EVENTS.TURN_END) ?? [];
    const modelCallStarts = events.byType.get(EVENTS.MODEL_CALL_START) ?? [];

    expect(turnStarts.length).toBeGreaterThanOrEqual(1);
    expect(modelCallStarts.length).toBeGreaterThanOrEqual(1);

    // Turn start should come before attempt start
    const turnStartTime = turnStarts[0].timestamp;
    const modelCallStartTime = modelCallStarts[0].timestamp;
    expect(turnStartTime).toBeLessThanOrEqual(modelCallStartTime);
  });
});

describe("Trace - Error Handling", () => {
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

  it("agent:end emitted even when agent throws", async () => {
    const agent = createAgent({
      id: "error_agent",
      handler: async () => {
        throw new Error("Test error");
      },
    });

    await expect(agent({})).rejects.toThrow("Test error");

    const starts = events.byType.get(EVENTS.AGENT_START) ?? [];
    const ends = events.byType.get(EVENTS.AGENT_END) ?? [];

    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);

    // End event should indicate failure
    const endEvent = ends[0] as any;
    expect(endEvent.success).toBe(false);
    expect(endEvent.error).toBeDefined();
    expect(endEvent.error.message).toBe("Test error");
  });

  it("parent receives agent:end even when child throws", async () => {
    const ChildAgent = createAgent({
      id: "failing_child",
      handler: async () => {
        throw new Error("Child error");
      },
    });

    const ParentAgent = createAgent({
      id: "parent_of_failing",
      handler: async () => {
        await ChildAgent({});
        return { done: true };
      },
    });

    await expect(ParentAgent({})).rejects.toThrow("Child error");

    const ends = events.byType.get(EVENTS.AGENT_END) ?? [];

    // Both parent and child should have end events
    expect(ends.length).toBe(2);

    // Both should indicate failure
    const childEnd = ends.find((e) => e.agentId === "failing_child") as any;
    const parentEnd = ends.find((e) => e.agentId === "parent_of_failing") as any;

    expect(childEnd.success).toBe(false);
    expect(parentEnd.success).toBe(false);
  });
});

// ============ Event Hierarchy Tests ============

describe("Trace - Event Hierarchy (agent → promptAgent → turn → prompt → model:call)", () => {
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

  it("single agent has correct event hierarchy", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "hierarchy_agent",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    await agent({});

    // Verify all event types are present
    const agentStarts = events.byType.get(EVENTS.AGENT_START) ?? [];
    const agentEnds = events.byType.get(EVENTS.AGENT_END) ?? [];
    const promptAgentStarts = events.byType.get(EVENTS.PROMPT_AGENT_START) ?? [];
    const promptAgentEnds = events.byType.get(EVENTS.PROMPT_AGENT_END) ?? [];
    const turnStarts = events.byType.get(EVENTS.TURN_START) ?? [];
    const turnEnds = events.byType.get(EVENTS.TURN_END) ?? [];
    const modelCallStarts = events.byType.get(EVENTS.MODEL_CALL_START) ?? [];
    const modelCallEnds = events.byType.get(EVENTS.MODEL_CALL_END) ?? [];

    // Each level should have 1 start and 1 end
    expect(agentStarts.length).toBe(1);
    expect(agentEnds.length).toBe(1);
    expect(promptAgentStarts.length).toBe(1);
    expect(promptAgentEnds.length).toBe(1);
    expect(turnStarts.length).toBe(1);
    expect(turnEnds.length).toBe(1);
    expect(modelCallStarts.length).toBe(1);
    expect(modelCallEnds.length).toBe(1);

    // All share same traceId
    const traceId = agentStarts[0].trace.traceId;
    expect(events.all.every((e) => e.trace.traceId === traceId)).toBe(true);
  });

  it("event order follows hierarchy: agent → promptAgent → turn → model:call", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "order_agent",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    await agent({});

    // Get event indices
    const findIndex = (type: string) => events.all.findIndex((e) => e.type === type);

    const agentStartIdx = findIndex(EVENTS.AGENT_START);
    const promptAgentStartIdx = findIndex(EVENTS.PROMPT_AGENT_START);
    const turnStartIdx = findIndex(EVENTS.TURN_START);
    const modelCallStartIdx = findIndex(EVENTS.MODEL_CALL_START);
    const modelCallEndIdx = findIndex(EVENTS.MODEL_CALL_END);
    const turnEndIdx = findIndex(EVENTS.TURN_END);
    const promptAgentEndIdx = findIndex(EVENTS.PROMPT_AGENT_END);
    const agentEndIdx = findIndex(EVENTS.AGENT_END);

    // Verify start order (outer to inner)
    expect(agentStartIdx).toBeLessThan(promptAgentStartIdx);
    expect(promptAgentStartIdx).toBeLessThan(turnStartIdx);
    expect(turnStartIdx).toBeLessThan(modelCallStartIdx);

    // Verify end order (inner to outer)
    expect(modelCallEndIdx).toBeLessThan(turnEndIdx);
    expect(turnEndIdx).toBeLessThan(promptAgentEndIdx);
    expect(promptAgentEndIdx).toBeLessThan(agentEndIdx);

    // model:call should be nested within turn
    expect(modelCallStartIdx).toBeGreaterThan(turnStartIdx);
    expect(modelCallEndIdx).toBeLessThan(turnEndIdx);
  });

  it("parentSpanId chain is correct through hierarchy", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "chain_agent",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    await agent({});

    // Get events
    const agentStart = events.byType.get(EVENTS.AGENT_START)![0]!;
    const promptAgentStart = events.byType.get(EVENTS.PROMPT_AGENT_START)![0]!;
    const turnStart = events.byType.get(EVENTS.TURN_START)![0]!;
    const modelCallStart = events.byType.get(EVENTS.MODEL_CALL_START)![0]!;

    // ========== Verify complete parentSpanId chain ==========

    // 1. Agent is root (no parent)
    expect(agentStart.trace.parentSpanId).toBe("");

    // 2. promptAgent runs in ctx.scope({ name: 'prompt' }) which creates a new span
    //    The scope's parent is generation's spanId (not agent's spanId)
    //    promptAgent:start is emitted inside the scope, so its parentSpanId = generation's spanId
    const generations = events.byType.get(EVENTS.GENERATION_START) ?? [];
    const generation = generations.find((e) => e.agentId === "chain_agent")!;
    expect(promptAgentStart.trace.parentSpanId).toBe(generation.trace.spanId);

    // 3. turn runs inside the scope, its parentSpanId = scope's spanId = promptAgentStart's spanId
    expect(turnStart.trace.parentSpanId).toBe(promptAgentStart.trace.spanId);

    // 4. model:call runs under turn scope
    expect(modelCallStart.trace.parentSpanId).toBe(turnStart.trace.spanId);

    // Verify all spanIds are unique
    const allSpanIds = [
      agentStart.trace.spanId,
      promptAgentStart.trace.spanId,
      turnStart.trace.spanId,
      modelCallStart.trace.spanId,
    ];
    expect(new Set(allSpanIds).size).toBe(4);

    // Verify all share same traceId
    expect(promptAgentStart.trace.traceId).toBe(agentStart.trace.traceId);
    expect(turnStart.trace.traceId).toBe(agentStart.trace.traceId);
    expect(modelCallStart.trace.traceId).toBe(agentStart.trace.traceId);
  });

  it("child agent has correct hierarchy under parent", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const ChildAgent = createAgent({
      id: "child_hierarchy",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    const ParentAgent = createAgent({
      id: "parent_hierarchy",
      model: mock.adapter,
      handler: async () => {
        return await ChildAgent({});
      },
    });

    await ParentAgent({});

    // Should have 2 of each (parent + child)
    const agentStarts = events.byType.get(EVENTS.AGENT_START) ?? [];
    const promptAgentStarts = events.byType.get(EVENTS.PROMPT_AGENT_START) ?? [];
    const turnStarts = events.byType.get(EVENTS.TURN_START) ?? [];
    const modelCallStarts = events.byType.get(EVENTS.MODEL_CALL_START) ?? [];

    expect(agentStarts.length).toBe(2);
    // Only child has promptAgent (parent is pure orchestrator calling child)
    expect(promptAgentStarts.length).toBe(1);
    expect(turnStarts.length).toBe(1);
    expect(modelCallStarts.length).toBe(1);

    // ========== Verify complete parentSpanId chain ==========

    const parentAgentStart = agentStarts.find((e) => e.agentId === "parent_hierarchy")!;
    const childAgentStart = agentStarts.find((e) => e.agentId === "child_hierarchy")!;
    const childPromptAgentStart = promptAgentStarts[0];
    const childTurnStart = turnStarts[0];
    const childModelCallStart = modelCallStarts[0];

    // 1. Parent agent is root
    expect(parentAgentStart.trace.parentSpanId).toBe("");

    // 2. Child agent's parent is parent agent's generation
    const parentGenerations = events.byType.get(EVENTS.GENERATION_START) ?? [];
    const parentGeneration = parentGenerations.find((e) => e.agentId === "parent_hierarchy")!;
    expect(childAgentStart.trace.parentSpanId).toBe(parentGeneration.trace.spanId);

    // 3. Child's promptAgent's parent is child agent's generation
    const childGenerations = events.byType.get(EVENTS.GENERATION_START) ?? [];
    const childGeneration = childGenerations.find((e) => e.agentId === "child_hierarchy")!;
    expect(childPromptAgentStart.trace.parentSpanId).toBe(childGeneration.trace.spanId);

    // 4. Child's turn's parent is child's promptAgent
    expect(childTurnStart.trace.parentSpanId).toBe(childPromptAgentStart.trace.spanId);

    // 5. Child's model:call's parent is child's turn
    expect(childModelCallStart.trace.parentSpanId).toBe(childTurnStart.trace.spanId);

    // All share same traceId
    expect(events.all.every((e) => e.trace.traceId === parentAgentStart.trace.traceId)).toBe(true);
  });

  it("parallel agents have independent hierarchies with shared traceId", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const WorkerA = createAgent({
      id: "worker_a",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    const WorkerB = createAgent({
      id: "worker_b",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    const Orchestrator = createAgent({
      id: "parallel_orchestrator",
      handler: async () => {
        const [a, b] = await Promise.all([WorkerA({}), WorkerB({})]);
        return { a, b };
      },
    });

    await Orchestrator({});

    // 3 agents total
    const agentStarts = events.byType.get(EVENTS.AGENT_START) ?? [];
    expect(agentStarts.length).toBe(3);

    // 2 promptAgent calls (one per worker)
    const promptAgentStarts = events.byType.get(EVENTS.PROMPT_AGENT_START) ?? [];
    expect(promptAgentStarts.length).toBe(2);

    // 2 turn calls
    const turnStarts = events.byType.get(EVENTS.TURN_START) ?? [];
    expect(turnStarts.length).toBe(2);

    // 2 model:call calls
    const modelCallStarts = events.byType.get(EVENTS.MODEL_CALL_START) ?? [];
    expect(modelCallStarts.length).toBe(2);

    // ========== Verify complete parentSpanId chain ==========

    const orchestratorStart = agentStarts.find((e) => e.agentId === "parallel_orchestrator")!;
    const workerAStart = agentStarts.find((e) => e.agentId === "worker_a")!;
    const workerBStart = agentStarts.find((e) => e.agentId === "worker_b")!;

    // 1. Orchestrator is root
    expect(orchestratorStart.trace.parentSpanId).toBe("");

    // 2. Both workers have orchestrator's generation as parent
    const orchestratorGenerations = events.byType.get(EVENTS.GENERATION_START) ?? [];
    const orchestratorGeneration = orchestratorGenerations.find(
      (e) => e.agentId === "parallel_orchestrator",
    )!;
    expect(workerAStart.trace.parentSpanId).toBe(orchestratorGeneration.trace.spanId);
    expect(workerBStart.trace.parentSpanId).toBe(orchestratorGeneration.trace.spanId);

    // 3. Each worker has independent hierarchy chain
    // Find events for each worker by matching parentSpanId chain
    // promptAgent's parent should be worker's generation, not worker's agent start
    const workerGenerations = events.byType.get(EVENTS.GENERATION_START) ?? [];
    const workerAGeneration = workerGenerations.find((e) => e.agentId === "worker_a")!;
    const workerBGeneration = workerGenerations.find((e) => e.agentId === "worker_b")!;

    const workerAPromptAgent = promptAgentStarts.find(
      (e) => e.trace.parentSpanId === workerAGeneration.trace.spanId,
    )!;
    const workerBPromptAgent = promptAgentStarts.find(
      (e) => e.trace.parentSpanId === workerBGeneration.trace.spanId,
    )!;

    expect(workerAPromptAgent).toBeDefined();
    expect(workerBPromptAgent).toBeDefined();

    // 4. Each promptAgent has corresponding turn
    const workerATurn = turnStarts.find(
      (e) => e.trace.parentSpanId === workerAPromptAgent.trace.spanId,
    )!;
    const workerBTurn = turnStarts.find(
      (e) => e.trace.parentSpanId === workerBPromptAgent.trace.spanId,
    )!;

    expect(workerATurn).toBeDefined();
    expect(workerBTurn).toBeDefined();

    // 5. Each turn has corresponding model:call
    const workerAModelCall = modelCallStarts.find(
      (e) => e.trace.parentSpanId === workerATurn.trace.spanId,
    )!;
    const workerBModelCall = modelCallStarts.find(
      (e) => e.trace.parentSpanId === workerBTurn.trace.spanId,
    )!;

    expect(workerAModelCall).toBeDefined();
    expect(workerBModelCall).toBeDefined();

    // Workers have different spanIds at each level
    expect(workerAStart.trace.spanId).not.toBe(workerBStart.trace.spanId);
    expect(workerAPromptAgent.trace.spanId).not.toBe(workerBPromptAgent.trace.spanId);
    expect(workerATurn.trace.spanId).not.toBe(workerBTurn.trace.spanId);
    expect(workerAModelCall.trace.spanId).not.toBe(workerBModelCall.trace.spanId);

    // All share same traceId
    const traceId = orchestratorStart.trace.traceId;
    expect(events.all.every((e) => e.trace.traceId === traceId)).toBe(true);
  });

  it("deep nested agents maintain full hierarchy chain", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    // Level 3: Leaf worker
    const LeafWorker = createAgent({
      id: "leaf_worker",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    // Level 2: Mid orchestrator (calls leaf)
    const MidOrchestrator = createAgent({
      id: "mid_orchestrator",
      handler: async () => {
        return await LeafWorker({});
      },
    });

    // Level 1: Top orchestrator (calls mid)
    const TopOrchestrator = createAgent({
      id: "top_orchestrator",
      handler: async () => {
        return await MidOrchestrator({});
      },
    });

    await TopOrchestrator({});

    // 3 agents
    const agentStarts = events.byType.get(EVENTS.AGENT_START) ?? [];
    expect(agentStarts.length).toBe(3);

    // Only leaf has promptAgent
    const promptAgentStarts = events.byType.get(EVENTS.PROMPT_AGENT_START) ?? [];
    expect(promptAgentStarts.length).toBe(1);

    const turnStarts = events.byType.get(EVENTS.TURN_START) ?? [];
    expect(turnStarts.length).toBe(1);

    const modelCallStarts = events.byType.get(EVENTS.MODEL_CALL_START) ?? [];
    expect(modelCallStarts.length).toBe(1);

    // ========== Verify complete parentSpanId chain ==========

    const topStart = agentStarts.find((e) => e.agentId === "top_orchestrator")!;
    const midStart = agentStarts.find((e) => e.agentId === "mid_orchestrator")!;
    const leafStart = agentStarts.find((e) => e.agentId === "leaf_worker")!;
    const leafPromptAgent = promptAgentStarts[0];
    const leafTurn = turnStarts[0];
    const leafModelCall = modelCallStarts[0];

    // 1. Agent hierarchy: top → mid → leaf
    expect(topStart.trace.parentSpanId).toBe(""); // root

    const topGenerations = events.byType.get(EVENTS.GENERATION_START) ?? [];
    const topGeneration = topGenerations.find((e) => e.agentId === "top_orchestrator")!;
    expect(midStart.trace.parentSpanId).toBe(topGeneration.trace.spanId);

    const midGenerations = events.byType.get(EVENTS.GENERATION_START) ?? [];
    const midGeneration = midGenerations.find((e) => e.agentId === "mid_orchestrator")!;
    expect(leafStart.trace.parentSpanId).toBe(midGeneration.trace.spanId);

    // 2. Leaf's inner hierarchy: leaf → promptAgent → turn → model:call
    const leafGenerations = events.byType.get(EVENTS.GENERATION_START) ?? [];
    const leafGeneration = leafGenerations.find((e) => e.agentId === "leaf_worker")!;
    expect(leafPromptAgent.trace.parentSpanId).toBe(leafGeneration.trace.spanId);
    expect(leafTurn.trace.parentSpanId).toBe(leafPromptAgent.trace.spanId);
    expect(leafModelCall.trace.parentSpanId).toBe(leafTurn.trace.spanId);

    // All share same traceId
    const traceId = topStart.trace.traceId;
    expect(events.all.every((e) => e.trace.traceId === traceId)).toBe(true);

    // All spanIds are unique
    const allSpanIds = [
      topStart.trace.spanId,
      midStart.trace.spanId,
      leafStart.trace.spanId,
      leafPromptAgent.trace.spanId,
      leafTurn.trace.spanId,
      leafModelCall.trace.spanId,
    ];
    expect(new Set(allSpanIds).size).toBe(6);
  });

  it("parallel workers with deep nesting maintain correct hierarchy", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const LeafWorker = createAgent({
      id: "leaf_worker",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    const MidOrchestrator = createAgent({
      id: "mid_orchestrator",
      handler: async () => {
        // Parallel leaf workers
        const [a, b] = await Promise.all([LeafWorker({}), LeafWorker({})]);
        return { a, b };
      },
    });

    const TopOrchestrator = createAgent({
      id: "top_orchestrator",
      handler: async () => {
        // Parallel mid orchestrators
        const [m1, m2] = await Promise.all([MidOrchestrator({}), MidOrchestrator({})]);
        return { m1, m2 };
      },
    });

    await TopOrchestrator({});

    // ========== Count verification ==========

    // Count: 1 top + 2 mid + 4 leaf = 7 agents
    const agentStarts = events.byType.get(EVENTS.AGENT_START) ?? [];
    expect(agentStarts.length).toBe(7);

    // 4 promptAgent (one per leaf)
    const promptAgentStarts = events.byType.get(EVENTS.PROMPT_AGENT_START) ?? [];
    expect(promptAgentStarts.length).toBe(4);

    // 4 turn (one per leaf)
    const turnStarts = events.byType.get(EVENTS.TURN_START) ?? [];
    expect(turnStarts.length).toBe(4);

    // 4 model:call (one per leaf)
    const modelCallStarts = events.byType.get(EVENTS.MODEL_CALL_START) ?? [];
    expect(modelCallStarts.length).toBe(4);

    // ========== Verify complete parentSpanId chain ==========

    const topStart = agentStarts.find((e) => e.agentId === "top_orchestrator")!;
    const midStarts = agentStarts.filter((e) => e.agentId === "mid_orchestrator");
    const leafStarts = agentStarts.filter((e) => e.agentId === "leaf_worker");

    expect(midStarts.length).toBe(2);
    expect(leafStarts.length).toBe(4);

    // 1. Top is root
    expect(topStart.trace.parentSpanId).toBe("");

    // 2. All mid orchestrators have top's generation as parent
    const topGenerations = events.byType.get(EVENTS.GENERATION_START) ?? [];
    const topGeneration = topGenerations.find((e) => e.agentId === "top_orchestrator")!;
    for (const mid of midStarts) {
      expect(mid.trace.parentSpanId).toBe(topGeneration.trace.spanId);
    }

    // 3. Each leaf has a mid's generation as parent (verify the exact relationship)
    const midGenerations = events.byType.get(EVENTS.GENERATION_START) ?? [];
    for (const leaf of leafStarts) {
      const parentMidGeneration = midGenerations.find(
        (gen) => gen.agentId === "mid_orchestrator" && gen.trace.spanId === leaf.trace.parentSpanId,
      );
      expect(parentMidGeneration).toBeDefined();
    }

    // 4. Each mid's generation has exactly 2 leaf children
    for (const midGen of midGenerations.filter((g) => g.agentId === "mid_orchestrator")) {
      const childLeaves = leafStarts.filter((l) => l.trace.parentSpanId === midGen.trace.spanId);
      expect(childLeaves.length).toBe(2);
    }

    // 5. Each leaf has complete inner hierarchy
    const leafGenerations = events.byType.get(EVENTS.GENERATION_START) ?? [];
    for (const leaf of leafStarts) {
      // Find the generation for this leaf
      // Leaf generation's parentSpanId should be leaf agent start's spanId
      const leafGeneration = leafGenerations.find(
        (g) => g.agentId === "leaf_worker" && g.trace.parentSpanId === leaf.trace.spanId,
      );
      expect(leafGeneration).toBeDefined();

      // Find the promptAgent for this leaf (parent should be leaf's generation)
      const leafPromptAgent = promptAgentStarts.find(
        (e) => e.trace.parentSpanId === leafGeneration!.trace.spanId,
      );
      expect(leafPromptAgent).toBeDefined();

      // Find the turn for this promptAgent
      const leafTurn = turnStarts.find(
        (e) => e.trace.parentSpanId === leafPromptAgent!.trace.spanId,
      );
      expect(leafTurn).toBeDefined();

      // Find the model:call for this turn
      const leafModelCall = modelCallStarts.find(
        (e) => e.trace.parentSpanId === leafTurn!.trace.spanId,
      );
      expect(leafModelCall).toBeDefined();
    }

    // All share same traceId
    const traceId = topStart.trace.traceId;
    expect(events.all.every((e) => e.trace.traceId === traceId)).toBe(true);

    // All spanIds are unique (7 agents + 4*3 inner events = 19 unique spans)
    const allSpanIds = events.all.map((e) => e.trace.spanId);
    // Each start has its own spanId, count unique ones
    const _uniqueSpanIds = new Set(allSpanIds);
    // We expect unique spans for: 7 agents + 4 promptAgent + 4 turn + 4 modelCall = 19 start events
    // But ends share spanId with starts, so counting starts only
    const startEvents = [...agentStarts, ...promptAgentStarts, ...turnStarts, ...modelCallStarts];
    const startSpanIds = startEvents.map((e) => e.trace.spanId);
    expect(new Set(startSpanIds).size).toBe(19);
  });
});

describe("Trace - Validation Events Hierarchy", () => {
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

  it("validation:success is child of promptAgent:start", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "validation_agent",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    await agent({});

    // Get promptAgent and validation events
    const promptAgentStarts = events.byType.get(EVENTS.PROMPT_AGENT_START) ?? [];
    const validationSuccesses = events.byType.get(EVENTS.VALIDATION_SUCCESS) ?? [];

    expect(promptAgentStarts.length).toBeGreaterThanOrEqual(1);
    expect(validationSuccesses.length).toBeGreaterThanOrEqual(1);

    // Validation is emitted under promptAgent scope.
    const promptAgentStart = promptAgentStarts[0];
    const validationSuccess = validationSuccesses.find(
      (e) => e.trace.parentSpanId === promptAgentStart.trace.spanId,
    );

    expect(validationSuccess).toBeDefined();
    expect(validationSuccess!.trace.parentSpanId).toBe(promptAgentStart.trace.spanId);
    expect(validationSuccess!.trace.traceId).toBe(promptAgentStart.trace.traceId);
  });

  it("validation:fail is child of promptAgent:start", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ wrong: "type" }); // Won't match schema

    const agent = createAgent({
      id: "validation_fail_agent",
      model: mock.adapter,
      maxRetries: 0, // No retries to get a single validation:fail
      handler: async () => promptAgent(schemas.simple),
    });

    await expect(agent({})).rejects.toThrow();

    // Get promptAgent and validation events
    const promptAgentStarts = events.byType.get(EVENTS.PROMPT_AGENT_START) ?? [];
    const validationFails = events.byType.get(EVENTS.VALIDATION_FAIL) ?? [];

    expect(promptAgentStarts.length).toBeGreaterThanOrEqual(1);
    expect(validationFails.length).toBeGreaterThanOrEqual(1);

    // Validation is emitted under promptAgent scope.
    const promptAgentStart = promptAgentStarts[0];
    const validationFail = validationFails.find(
      (e) => e.trace.parentSpanId === promptAgentStart.trace.spanId,
    );

    expect(validationFail).toBeDefined();
    expect(validationFail!.trace.parentSpanId).toBe(promptAgentStart.trace.spanId);
    expect(validationFail!.trace.traceId).toBe(promptAgentStart.trace.traceId);
  });

  it("validation events are within promptAgent scope (success case)", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "validation_scope_agent",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    await agent({});

    // Get events
    const turnEnds = events.byType.get(EVENTS.TURN_END) ?? [];
    const promptAgentStarts = events.byType.get(EVENTS.PROMPT_AGENT_START) ?? [];
    const promptAgentEnds = events.byType.get(EVENTS.PROMPT_AGENT_END) ?? [];
    const modelCallStarts = events.byType.get(EVENTS.MODEL_CALL_START) ?? [];
    const modelCallEnds = events.byType.get(EVENTS.MODEL_CALL_END) ?? [];
    const validationSuccesses = events.byType.get(EVENTS.VALIDATION_SUCCESS) ?? [];

    expect(turnEnds.length).toBeGreaterThanOrEqual(1);
    expect(promptAgentStarts.length).toBeGreaterThanOrEqual(1);
    expect(promptAgentEnds.length).toBeGreaterThanOrEqual(1);
    expect(modelCallStarts.length).toBeGreaterThanOrEqual(1);
    expect(modelCallEnds.length).toBeGreaterThanOrEqual(1);
    expect(validationSuccesses.length).toBeGreaterThanOrEqual(1);

    // Find matching prompt/turn/modelCall/validation
    const promptAgentStart = promptAgentStarts[0];
    const promptAgentEnd = promptAgentEnds.find(
      (e) => e.trace.spanId === promptAgentStart.trace.spanId,
    )!;
    const turnEnd = turnEnds[0];
    const modelCallStart = modelCallStarts[0];
    const modelCallEnd = modelCallEnds.find((e) => e.trace.spanId === modelCallStart.trace.spanId)!;
    const validationSuccess = validationSuccesses.find(
      (e) => e.trace.parentSpanId === promptAgentStart.trace.spanId,
    )!;

    // Verify validation:success is child of promptAgent:start
    expect(validationSuccess.trace.parentSpanId).toBe(promptAgentStart.trace.spanId);

    // Verify event order: model:call:start < model:call:end < turn:end < validation:success < promptAgent:end
    const modelCallStartIdx = events.all.indexOf(modelCallStart);
    const modelCallEndIdx = events.all.indexOf(modelCallEnd);
    const turnEndIdx = events.all.indexOf(turnEnd);
    const validationSuccessIdx = events.all.indexOf(validationSuccess);
    const promptAgentEndIdx = events.all.indexOf(promptAgentEnd);

    expect(modelCallStartIdx).toBeLessThan(modelCallEndIdx);
    expect(modelCallEndIdx).toBeLessThan(turnEndIdx);
    expect(turnEndIdx).toBeLessThan(validationSuccessIdx);
    expect(validationSuccessIdx).toBeLessThan(promptAgentEndIdx);
  });

  it("validation events are within promptAgent scope (fail case)", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ wrong: "type" }); // Won't match schema

    const agent = createAgent({
      id: "validation_fail_scope_agent",
      model: mock.adapter,
      maxRetries: 0, // No retries
      handler: async () => promptAgent(schemas.simple),
    });

    await expect(agent({})).rejects.toThrow();

    // Get events
    const turnEnds = events.byType.get(EVENTS.TURN_END) ?? [];
    const promptAgentStarts = events.byType.get(EVENTS.PROMPT_AGENT_START) ?? [];
    const modelCallStarts = events.byType.get(EVENTS.MODEL_CALL_START) ?? [];
    const modelCallEnds = events.byType.get(EVENTS.MODEL_CALL_END) ?? [];
    const validationFails = events.byType.get(EVENTS.VALIDATION_FAIL) ?? [];

    expect(turnEnds.length).toBeGreaterThanOrEqual(1);
    expect(promptAgentStarts.length).toBeGreaterThanOrEqual(1);
    expect(modelCallStarts.length).toBeGreaterThanOrEqual(1);
    expect(modelCallEnds.length).toBeGreaterThanOrEqual(1);
    expect(validationFails.length).toBeGreaterThanOrEqual(1);

    // Find matching prompt/turn/modelCall/validation
    const promptAgentStart = promptAgentStarts[0];
    const turnEnd = turnEnds[0];
    const modelCallStart = modelCallStarts[0];
    const modelCallEnd = modelCallEnds.find((e) => e.trace.spanId === modelCallStart.trace.spanId)!;
    const validationFail = validationFails.find(
      (e) => e.trace.parentSpanId === promptAgentStart.trace.spanId,
    )!;

    // Verify validation:fail is child of promptAgent:start
    expect(validationFail.trace.parentSpanId).toBe(promptAgentStart.trace.spanId);

    // Verify event order: model:call:start < model:call:end < turn:end < validation:fail
    const modelCallStartIdx = events.all.indexOf(modelCallStart);
    const modelCallEndIdx = events.all.indexOf(modelCallEnd);
    const turnEndIdx = events.all.indexOf(turnEnd);
    const validationFailIdx = events.all.indexOf(validationFail);

    expect(modelCallStartIdx).toBeLessThan(modelCallEndIdx);
    expect(modelCallEndIdx).toBeLessThan(turnEndIdx);
    expect(turnEndIdx).toBeLessThan(validationFailIdx);
  });

  it("multiple attempts each have their own validation events", async () => {
    const mock = createMockModel();
    // First attempt fails, second succeeds
    mock.sequence([
      { type: "json", content: { wrong: "type" } }, // First attempt fails validation
      { type: "json", content: { result: "ok" } }, // Second attempt succeeds
    ]);

    const agent = createAgent({
      id: "retry_validation_agent",
      model: mock.adapter,
      maxRetries: 1, // Allow one retry
      handler: async () => promptAgent(schemas.simple),
    });

    await agent({});

    // Get events
    const modelCallStarts = events.byType.get(EVENTS.MODEL_CALL_START) ?? [];
    const turnStarts = events.byType.get(EVENTS.TURN_START) ?? [];
    const validationFails = events.byType.get(EVENTS.VALIDATION_FAIL) ?? [];
    const validationSuccesses = events.byType.get(EVENTS.VALIDATION_SUCCESS) ?? [];

    const promptAgentStarts = events.byType.get(EVENTS.PROMPT_AGENT_START) ?? [];
    expect(modelCallStarts.length).toBe(2); // Two model calls
    expect(turnStarts.length).toBe(2); // One turn span per attempt
    expect(promptAgentStarts.length).toBe(1);
    expect(validationFails.length).toBeGreaterThanOrEqual(1);
    expect(validationSuccesses.length).toBeGreaterThanOrEqual(1);

    // Both validation events should belong to the same promptAgent scope.
    const promptAgentStart = promptAgentStarts[0];
    const firstValidationFail = validationFails.find(
      (e) => e.trace.parentSpanId === promptAgentStart.trace.spanId,
    );
    const secondValidationSuccess = validationSuccesses.find(
      (e) => e.trace.parentSpanId === promptAgentStart.trace.spanId,
    );
    expect(firstValidationFail).toBeDefined();
    expect(secondValidationSuccess).toBeDefined();

    // First and second model calls still exist for retry sequence checks.
    const firstModelCall = modelCallStarts[0];
    const secondModelCall = modelCallStarts[1];
    const firstModelCallIdx = events.all.indexOf(firstModelCall);
    const firstValidationFailIdx = events.all.indexOf(firstValidationFail!);
    const secondModelCallIdx = events.all.indexOf(secondModelCall);
    const secondValidationSuccessIdx = events.all.indexOf(secondValidationSuccess!);
    expect(firstModelCallIdx).toBeLessThan(firstValidationFailIdx);
    expect(firstValidationFailIdx).toBeLessThan(secondModelCallIdx);
    expect(secondModelCallIdx).toBeLessThan(secondValidationSuccessIdx);

    // All should share same traceId
    const traceId = firstModelCall.trace.traceId;
    expect(promptAgentStart.trace.traceId).toBe(traceId);
    expect(secondModelCall.trace.traceId).toBe(traceId);
    expect(firstValidationFail!.trace.traceId).toBe(traceId);
    expect(secondValidationSuccess!.trace.traceId).toBe(traceId);
  });
});

// ============ Model Call Event Tests ============

describe("Trace - Model Call Events", () => {
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

  it("model:call has correct parentSpanId pointing to turn scope", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test_agent",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    await agent({});

    // Get events
    const turnStarts = events.byType.get(EVENTS.TURN_START) ?? [];
    const modelCallStarts = events.byType.get(EVENTS.MODEL_CALL_START) ?? [];

    expect(turnStarts.length).toBe(1);
    expect(modelCallStarts.length).toBe(1);

    const turnStart = turnStarts[0];
    const modelCallStart = modelCallStarts[0];

    // model:call's parentSpanId should be turn's spanId
    expect(modelCallStart.trace.parentSpanId).toBe(turnStart.trace.spanId);
  });

  it("nested wrappers get correct parentSpanId from model call context", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    // Create a capturing wrapper to verify context
    let capturedTrace: any;
    const capturingWrapper = (inner: any) => ({
      ...inner,
      id: `capturing:${inner.id}`,
      async *stream(...args: any[]) {
        const ctx = getCurrentContextSafe();
        capturedTrace = ctx?.trace;
        yield* inner.stream(...args);
      },
    });

    const baseAdapter = mock.adapter;
    const wrapped = capturingWrapper(baseAdapter);

    const agent = createAgent({
      id: "nested_wrapper_agent",
      model: wrapped,
      handler: async () => promptAgent(schemas.simple),
    });

    await agent({});

    expect(capturedTrace).toBeDefined();

    // Get model:call event
    const modelCallStarts = events.byType.get(EVENTS.MODEL_CALL_START) ?? [];
    expect(modelCallStarts.length).toBe(1);

    const modelCallStart = modelCallStarts[0];

    // Both share the same traceId
    expect(capturedTrace.traceId).toBe(modelCallStart.trace.traceId);

    // Inner wrapper sees model call's context
    // Its spanId should match model:call's spanId
    expect(capturedTrace.spanId).toBe(modelCallStart.trace.spanId);

    // Both have same parentSpanId (pointing to prompt scope)
    expect(capturedTrace.parentSpanId).toBe(modelCallStart.trace.parentSpanId);
  });

  it("multiple model calls each create their own span", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    // Each promptAgent must run in its own run (one promptAgent per run)
    const ChildAgent = createAgent({
      id: "child",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    const agent = createAgent({
      id: "double_call_agent",
      model: mock.adapter,
      handler: async () => {
        const [result1, result2] = await Promise.all([ChildAgent({}), ChildAgent({})]);
        return { result1, result2 };
      },
    });

    await agent({});

    // Should have 2 model:call events
    const modelCallStarts = events.byType.get(EVENTS.MODEL_CALL_START) ?? [];
    expect(modelCallStarts.length).toBe(2);

    // They should have different spanIds
    const firstSpanId = modelCallStarts[0].trace.spanId;
    const secondSpanId = modelCallStarts[1].trace.spanId;
    expect(firstSpanId).not.toBe(secondSpanId);

    // Both should share the same traceId
    expect(modelCallStarts[0].trace.traceId).toBe(modelCallStarts[1].trace.traceId);
  });
});

describe("Trace - runWith trace options", () => {
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

  it("runWith trace option (traceId, parentSpanId, attributes) takes effect", async () => {
    const customTraceId = "custom-trace-id-123";
    const customParentSpanId = "parent-span-456";
    const customAttrs = { requestId: "req-1", region: "us" };

    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "inner_agent",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    await runWith(async () => agent({}), {
      trace: {
        traceId: customTraceId,
        parentSpanId: customParentSpanId,
        attributes: customAttrs,
      },
    });

    const runWithStarts = events.byType.get(EVENTS.RUN_WITH_START) ?? [];
    expect(runWithStarts.length).toBe(1);
    expect(runWithStarts[0].trace.traceId).toBe(customTraceId);
    expect(runWithStarts[0].trace.parentSpanId).toBe(customParentSpanId);
    expect(runWithStarts[0].trace.attributes).toEqual(customAttrs);

    // All events in this run should share the same traceId
    const agentStarts = events.byType.get(EVENTS.AGENT_START) ?? [];
    expect(agentStarts.length).toBe(1);
    expect(agentStarts[0].trace.traceId).toBe(customTraceId);
  });
});

describe("Trace - equipTraceAttr", () => {
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

  it("equipTraceAttr attrs appear on agent:end only; agent:end has last generation attr", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    let runCount = 0;
    const agent = createAgent({
      id: "reborn_attr_agent",
      model: mock.adapter,
      handler: async () => {
        runCount++;
        equipTraceAttr({ gen: runCount, tag: `gen-${runCount}` });
        if (runCount < 3) return reborn();
        return { done: true };
      },
    });

    await agent({});

    const generationEnds = events.byType.get(EVENTS.GENERATION_END) ?? [];
    const agentEnds = events.byType.get(EVENTS.AGENT_END) ?? [];

    expect(generationEnds.length).toBe(3);
    expect(agentEnds.length).toBe(1);

    // target agent no longer decorates generation:end.
    expect(generationEnds[0].trace.attributes).toBeUndefined();
    expect(generationEnds[1].trace.attributes).toBeUndefined();
    expect(generationEnds[2].trace.attributes).toBeUndefined();

    // Agent:end has the last generation's attr
    expect(agentEnds[0].trace.attributes).toEqual({ gen: 3, tag: "gen-3" });
  });

  it("multiple equipTraceAttr: later overrides earlier (same key overwritten, new keys merged)", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "multi_attr_agent",
      model: mock.adapter,
      handler: async () => {
        equipTraceAttr({ a: 1 });
        equipTraceAttr({ b: 2 });
        equipTraceAttr({ a: 3 });
        return promptAgent(schemas.simple);
      },
    });

    await agent({});

    const agentEnds = events.byType.get(EVENTS.AGENT_END) ?? [];
    expect(agentEnds.length).toBe(1);
    expect(agentEnds[0].trace.attributes).toEqual({ a: 3, b: 2 });
  });
});
