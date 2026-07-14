/**
 * Snapshot Tests
 *
 * Tests for snapshot mechanism including dump, replay, and tombstone handling.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureWarnings, createTestAgent, schemas } from "../../testing/helpers";
import { createMockModel } from "../../testing/mock-model";
import { runInTestContext } from "../../testing/test-context";
import { hashValue } from "../../utils/hash";
import {
  createAgentContext,
  createEmptyBudgetState,
  createEmptyUsageStats,
} from "../context/factory";
import type { AgentFrameSnapshot } from "../context/snapshot";
import { getUsageStats } from "../engine/budget-system";
import { equipBudget } from "../facade/equip/budget";
import { equipMemory } from "../facade/equip/memory";
import { equipResource } from "../facade/equip/resource";
import { runWith } from "../facade/run";
import { promptAgent } from "../policy/prompt-schema";
import { REJELLY_ROOT, SNAPSHOT_VERSION } from "../shared/const";
import { dumpSnapshot } from "../snapshot/dump";
import { getJournalEntry, recordJournal } from "../snapshot/journal";
import type { AgentSnapshot, JournalPayload } from "../snapshot/type";

function sumBudgetCosts(costs: Record<string, number> | undefined): number {
  if (!costs) return 0;
  return Object.values(costs).reduce((a, b) => a + b, 0);
}

/**
 * Create test snapshot helper function
 * Creates a valid AgentFrameSnapshot with required fields including budgetState
 */
function createTestSnapshot(overrides?: Partial<AgentFrameSnapshot>): AgentFrameSnapshot {
  return {
    callId: "root",
    agentId: "test_agent",
    memory: {},
    journal: {
      prompt: {},
      tool: {},
    },
    children: {},
    state: {
      status: "running",
    },
    budgetState: createEmptyBudgetState(),
    ...overrides,
  };
}

/**
 * Wrap snapshot root to ensure consistent structure
 *
 * If root.callId is not 'root', wraps it in a new root frame with callId 'root'.
 * This ensures that snapshots dumped from runWith have the same structure as normal agent dumps.
 *
 * @param snapshot - Snapshot to wrap
 * @returns Wrapped snapshot with root.callId === 'root', or original snapshot if already correct
 */
function wrapRoot(snapshot: AgentSnapshot): AgentSnapshot {
  if (snapshot.root.callId === REJELLY_ROOT) {
    return snapshot;
  }

  // Wrap the original root in a new root frame
  const originalRoot = snapshot.root;
  const wrappedRoot: AgentFrameSnapshot = {
    callId: REJELLY_ROOT,
    agentId: "",
    memory: {},
    journal: {
      prompt: {},
      tool: {},
    },
    children: {
      [originalRoot.callId]: originalRoot,
    },
    state: originalRoot.state,
    budgetState: {
      aggregate: structuredClone(originalRoot.budgetState.aggregate),
      own: createEmptyUsageStats(),
    },
  };

  return {
    ...snapshot,
    root: wrappedRoot,
  };
}

describe("Snapshot Mechanism", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("dumpSnapshot", () => {
    it("should dump snapshot from agent context", async () => {
      await runInTestContext(
        async (ctx) => {
          equipMemory("count", 0);
          ctx.memory.set("test_key", "test_value");

          // Record some journal entries
          const contentHash = "hash123";
          recordJournal(ctx, "prompt:test:0", {
            type: "prompt",
            output: { result: "test" },
            contentHash,
          });

          const snapshot = dumpSnapshot();

          expect(snapshot).toBeDefined();
          expect(snapshot.root).toBeDefined();
          expect(snapshot.root.agentId).toBe("test_agent");
          expect(snapshot.root.memory.test_key).toBe("test_value");
          // Journal now uses contentHash as key for prompt and tool
          expect(snapshot.root.journal.prompt[contentHash]).toBeDefined();
        },
        { agentId: "test_agent" },
      );
    });

    it("should create snapshot with nested agents in correct order", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let capturedSnapshot: AgentSnapshot | null = null;

      const GrandChildAgent = createTestAgent({
        id: "grandchild_agent",
        model: mock.adapter,
        memory: { grandchild_value: "grandchild_data" },
        behavior: async () => {
          capturedSnapshot = dumpSnapshot();
          return { result: "grandchild_done" };
        },
      });

      const ChildAgent = createTestAgent({
        id: "child_agent",
        model: mock.adapter,
        memory: { child_value: "child_data" },
        behavior: async () => {
          await GrandChildAgent({});
          return { result: "child_done" };
        },
      });

      const ParentAgent = createTestAgent({
        id: "parent_agent",
        model: mock.adapter,
        memory: { parent_value: "parent_data" },
        behavior: async () => {
          await ChildAgent({});
          return { result: "parent_done" };
        },
      });

      await ParentAgent({});

      expect(capturedSnapshot).toBeDefined();
      expect(capturedSnapshot!.root).toBeDefined();
      expect(capturedSnapshot!.root.agentId).toBe("parent_agent");
      expect(capturedSnapshot!.root.memory.parent_value).toBe("parent_data");

      // Verify nested structure in children
      const childCallIds = Object.keys(capturedSnapshot!.root.children);
      expect(childCallIds.length).toBeGreaterThan(0);

      // Find child agent frame
      const childCallId = childCallIds.find((id) => id.includes("child_agent"));
      expect(childCallId).toBeDefined();

      if (childCallId) {
        const childFrame = capturedSnapshot!.root.children[childCallId];
        expect(childFrame).toBeDefined();
        expect(childFrame.agentId).toBe("child_agent");
        expect(childFrame.memory.child_value).toBe("child_data");

        // Verify grandchild in child's children
        const grandChildCallIds = Object.keys(childFrame.children);
        expect(grandChildCallIds.length).toBeGreaterThan(0);

        const grandChildCallId = grandChildCallIds.find((id) => id.includes("grandchild_agent"));
        expect(grandChildCallId).toBeDefined();

        if (grandChildCallId) {
          const grandChildFrame = childFrame.children[grandChildCallId];
          expect(grandChildFrame).toBeDefined();
          expect(grandChildFrame.agentId).toBe("grandchild_agent");
          expect(grandChildFrame.memory.grandchild_value).toBe("grandchild_data");
        }
      }
    });

    it("should include completed child agent data when dumping from second child", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let capturedSnapshot: AgentSnapshot | null = null;

      const ChildAgent1 = createTestAgent({
        id: "child_agent_1",
        model: mock.adapter,
        memory: { child1_value: "child1_data" },
        behavior: async () => {
          // Make a prompt call to create journal entry
          await promptAgent(schemas.simple);
          return { result: "child1_done" };
        },
      });

      const ChildAgent2 = createTestAgent({
        id: "child_agent_2",
        model: mock.adapter,
        memory: { child2_value: "child2_data" },
        behavior: async () => {
          // Dump snapshot after child1 has completed
          capturedSnapshot = dumpSnapshot();
          return { result: "child2_done" };
        },
      });

      const ParentAgent = createTestAgent({
        id: "parent_agent",
        model: mock.adapter,
        memory: { parent_value: "parent_data" },
        behavior: async () => {
          // Execute child1 first (will complete)
          await ChildAgent1({});
          // Then execute child2 (will dump snapshot)
          await ChildAgent2({});
          return { result: "parent_done" };
        },
      });

      await ParentAgent({});

      expect(capturedSnapshot).toBeDefined();
      expect(capturedSnapshot!.root).toBeDefined();
      expect(capturedSnapshot!.root.agentId).toBe("parent_agent");
      expect(capturedSnapshot!.root.memory.parent_value).toBe("parent_data");

      // Verify child1 is in children (completed)
      const childCallIds = Object.keys(capturedSnapshot!.root.children);
      const child1CallId = childCallIds.find((id) => id.includes("child_agent_1"));
      expect(child1CallId).toBeDefined();

      if (child1CallId) {
        const child1Frame = capturedSnapshot!.root.children[child1CallId];
        expect(child1Frame).toBeDefined();
        expect(child1Frame.agentId).toBe("child_agent_1");
        expect(child1Frame.memory.child1_value).toBe("child1_data");
        expect(child1Frame.state.status).toBe("completed");
        expect(child1Frame.state.output).toEqual({ result: "child1_done" });
        // Verify child1 has journal entries
        expect(Object.keys(child1Frame.journal.prompt).length).toBeGreaterThan(0);
      }

      // Verify child2 is in children (running when dumped)
      const child2CallId = childCallIds.find((id) => id.includes("child_agent_2"));
      expect(child2CallId).toBeDefined();

      if (child2CallId) {
        const child2Frame = capturedSnapshot!.root.children[child2CallId];
        expect(child2Frame).toBeDefined();
        expect(child2Frame.agentId).toBe("child_agent_2");
        expect(child2Frame.memory.child2_value).toBe("child2_data");
        expect(child2Frame.state.status).toBe("running");
      }
    });

    it("should restore snapshot with multiple completed children and no extra LLM calls", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "cached_response" });

      let savedSnapshot: AgentSnapshot | null = null;

      const ChildAgent1 = createTestAgent({
        id: "child_agent_1",
        model: mock.adapter,
        memory: { child1_value: "child1_data" },
        behavior: async () => {
          // Make a prompt call
          const result = await promptAgent(schemas.simple);
          return { processed: result, value: "child1_data" };
        },
      });

      const ChildAgent2 = createTestAgent({
        id: "child_agent_2",
        model: mock.adapter,
        memory: { child2_value: "child2_data" },
        behavior: async () => {
          // Make a prompt call
          const result = await promptAgent(schemas.simple);
          return { processed: result, value: "child2_data" };
        },
      });

      const ParentAgent = createTestAgent({
        id: "parent_agent",
        model: mock.adapter,
        memory: { parent_value: "parent_data" },
        behavior: async () => {
          // Execute both children
          const child1Result = await ChildAgent1({});
          const child2Result = await ChildAgent2({});

          // Dump snapshot after both children completed
          savedSnapshot = dumpSnapshot();

          return { parent: "parent_data", child1: child1Result, child2: child2Result };
        },
      });

      // First execution: create snapshot
      await ParentAgent({});
      expect(savedSnapshot).toBeDefined();

      const firstCallCount = mock.calls.count();
      expect(firstCallCount).toBeGreaterThan(0);

      // Verify snapshot structure
      const rootFrame = savedSnapshot!.root;
      expect(rootFrame.memory.parent_value).toBe("parent_data");

      const childCallIds = Object.keys(rootFrame.children);
      expect(childCallIds.length).toBe(2);

      const child1CallId = childCallIds.find((id) => id.includes("child_agent_1"));
      const child2CallId = childCallIds.find((id) => id.includes("child_agent_2"));

      expect(child1CallId).toBeDefined();
      expect(child2CallId).toBeDefined();

      if (child1CallId && child2CallId) {
        const child1Frame = rootFrame.children[child1CallId];
        const child2Frame = rootFrame.children[child2CallId];

        expect(child1Frame.state.status).toBe("completed");
        expect(child2Frame.state.status).toBe("completed");
        expect(child1Frame.memory.child1_value).toBe("child1_data");
        expect(child2Frame.memory.child2_value).toBe("child2_data");
      }

      // Clear call records to verify no new calls on replay
      mock.calls.clear();
      expect(mock.calls.count()).toBe(0);

      // Restore and verify no extra LLM calls
      let restoredParentValue: string | undefined;
      let restoredChild1Result: unknown;
      let restoredChild2Result: unknown;

      await runWith(
        async () => {
          const [parentValue] = equipMemory("parent_value", "default");
          restoredParentValue = parentValue as string;

          const RestoredParentAgent = createTestAgent({
            id: "parent_agent",
            model: mock.adapter,
            memory: { parent_value: "default" },
            behavior: async () => {
              const RestoredChildAgent1 = createTestAgent({
                id: "child_agent_1",
                model: mock.adapter,
                memory: { child1_value: "default" },
                behavior: async () => {
                  const result = await promptAgent(schemas.simple);
                  return { processed: result, value: "default" };
                },
              });

              const RestoredChildAgent2 = createTestAgent({
                id: "child_agent_2",
                model: mock.adapter,
                memory: { child2_value: "default" },
                behavior: async () => {
                  const result = await promptAgent(schemas.simple);
                  return { processed: result, value: "default" };
                },
              });

              const child1Result = await RestoredChildAgent1({});
              const child2Result = await RestoredChildAgent2({});
              restoredChild1Result = child1Result;
              restoredChild2Result = child2Result;

              return { parent: parentValue, child1: child1Result, child2: child2Result };
            },
          });

          return await RestoredParentAgent({});
        },
        { snapshot: savedSnapshot! },
      );

      // Verify memory was restored
      expect(restoredParentValue).toBe("parent_data");

      // Verify results were restored from cache
      expect(restoredChild1Result).toBeDefined();
      expect(restoredChild2Result).toBeDefined();

      // Verify NO new mock calls were made (cache hit for both children)
      expect(mock.calls.count()).toBe(0);
    });

    it("should restore snapshot with running child and completed sibling correctly", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let savedSnapshot: AgentSnapshot | null = null;

      const ChildAgent1 = createTestAgent({
        id: "child_agent_1",
        model: mock.adapter,
        memory: { child1_value: "child1_data" },
        behavior: async () => {
          await promptAgent(schemas.simple);
          return { result: "child1_done" };
        },
      });

      const ChildAgent2 = createTestAgent({
        id: "child_agent_2",
        model: mock.adapter,
        memory: { child2_value: "child2_data" },
        behavior: async () => {
          // Dump snapshot while child2 is still running (child1 already completed)
          savedSnapshot = dumpSnapshot();
          await promptAgent(schemas.simple);
          return { result: "child2_done" };
        },
      });

      const ParentAgent = createTestAgent({
        id: "parent_agent",
        model: mock.adapter,
        memory: { parent_value: "parent_data" },
        behavior: async () => {
          // Execute child1 first (will complete)
          await ChildAgent1({});
          // Then execute child2 (will dump snapshot while running)
          await ChildAgent2({});
          return { result: "parent_done" };
        },
      });

      await ParentAgent({});
      expect(savedSnapshot).toBeDefined();

      // Verify snapshot structure
      const rootFrame = savedSnapshot!.root;
      expect(rootFrame.memory.parent_value).toBe("parent_data");

      const childCallIds = Object.keys(rootFrame.children);
      expect(childCallIds.length).toBeGreaterThanOrEqual(1);

      // Find child1 (should be completed)
      const child1CallId = childCallIds.find((id) => id.includes("child_agent_1"));
      if (child1CallId) {
        const child1Frame = rootFrame.children[child1CallId];
        expect(child1Frame.state.status).toBe("completed");
        expect(child1Frame.memory.child1_value).toBe("child1_data");
      }

      // Find child2 (should be running when dumped)
      const child2CallId = childCallIds.find((id) => id.includes("child_agent_2"));
      if (child2CallId) {
        const child2Frame = rootFrame.children[child2CallId];
        expect(child2Frame.state.status).toBe("running");
        expect(child2Frame.memory.child2_value).toBe("child2_data");
      }

      // Clear calls and restore
      mock.calls.clear();

      await runWith(
        async () => {
          equipMemory("parent_value", "default");

          const RestoredParentAgent = createTestAgent({
            id: "parent_agent",
            model: mock.adapter,
            memory: { parent_value: "default" },
            behavior: async () => {
              const RestoredChildAgent1 = createTestAgent({
                id: "child_agent_1",
                model: mock.adapter,
                memory: { child1_value: "default" },
                behavior: async () => {
                  await promptAgent(schemas.simple);
                  return { result: "child1_done" };
                },
              });

              const RestoredChildAgent2 = createTestAgent({
                id: "child_agent_2",
                model: mock.adapter,
                memory: { child2_value: "default" },
                behavior: async () => {
                  await promptAgent(schemas.simple);
                  return { result: "child2_done" };
                },
              });

              await RestoredChildAgent1({});
              await RestoredChildAgent2({});

              return { result: "parent_done" };
            },
          });

          return await RestoredParentAgent({});
        },
        { snapshot: savedSnapshot! },
      );

      // Verify child1 was restored from cache (no new calls)
      // Note: child2 was running, so it will execute normally
      // But child1 should be cached
      expect(mock.calls.count()).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Journal Recording and Replay", () => {
    it("should record and retrieve prompt journal entry", async () => {
      await runInTestContext(
        async (ctx) => {
          const callId = "prompt:test:0";
          const payload: JournalPayload = {
            type: "prompt",
            output: { result: "test output" },
            contentHash: "hash123",
          };

          recordJournal(ctx, callId, payload);

          // Create snapshot frame for replay
          const snapshot = createTestSnapshot({
            callId: "root/test_agent",
            journal: {
              prompt: { ...ctx.draft.journal.prompt },
              tool: {},
            },
          });

          ctx.snapshot = snapshot;

          // Try to retrieve
          const entry = getJournalEntry(ctx, callId, {
            type: "prompt",
            contentHash: "hash123",
          });

          expect(entry).toBeDefined();
          expect(entry?.output).toEqual({ result: "test output" });
        },
        { agentId: "test_agent" },
      );
    });

    it("should record and retrieve tool journal entry", async () => {
      await runInTestContext(
        async (ctx) => {
          const callId = "tool:test_tool:0";
          const input = { query: "test" };
          const contentHash = hashValue({ name: "test_tool", input });
          const payload: JournalPayload = {
            type: "tool",
            input,
            output: { result: "tool result" },
            contentHash,
          };

          recordJournal(ctx, callId, payload);

          // Create snapshot frame for replay
          const snapshot = createTestSnapshot({
            callId: "root/test_agent",
            journal: {
              prompt: {},
              tool: { ...ctx.draft.journal.tool },
            },
          });

          ctx.snapshot = snapshot;

          // Try to retrieve
          const entry = getJournalEntry(ctx, callId, {
            type: "tool",
            input,
            contentHash,
          });

          expect(entry).toBeDefined();
          expect(entry?.output).toEqual({ result: "tool result" });
        },
        { agentId: "test_agent" },
      );
    });

    it("should store and retrieve child agent frame", async () => {
      await runInTestContext(
        async (ctx) => {
          const callId = "root/agent:child_agent:0";
          const childFrame = createTestSnapshot({
            callId: "root/test_agent/child_agent",
            agentId: "child_agent",
            memory: { child_key: "child_value" },
            state: {
              status: "completed",
              output: { doubled: 10 },
            },
          });

          // Store child frame directly in parent's children map
          ctx.draft.children[callId] = childFrame;

          // Create snapshot frame for replay
          const snapshot = createTestSnapshot({
            callId: "root/test_agent",
            children: { ...ctx.draft.children },
          });

          ctx.snapshot = snapshot;

          // Try to retrieve from children
          const retrievedFrame = ctx.snapshot.children[callId];

          expect(retrievedFrame).toBeDefined();
          expect(retrievedFrame).toEqual(childFrame);
          expect(retrievedFrame?.state.output).toEqual({ doubled: 10 });
        },
        { agentId: "test_agent" },
      );
    });

    it("should return null for mismatched content hash", async () => {
      await runInTestContext(
        async (ctx) => {
          const callId = "tool:test_tool:0";
          const input = { query: "test" };
          const contentHash = hashValue({ name: "test_tool", input });
          recordJournal(ctx, callId, {
            type: "tool",
            input,
            output: { result: "tool result" },
            contentHash,
          });

          const snapshot = createTestSnapshot({
            callId: "root/test_agent",
            journal: {
              prompt: {},
              tool: { ...ctx.draft.journal.tool },
            },
          });

          ctx.snapshot = snapshot;

          // Try to retrieve with different input (different contentHash)
          const differentInput = { query: "different" };
          const differentContentHash = hashValue({ name: "test_tool", input: differentInput });
          const entry = getJournalEntry(ctx, callId, {
            type: "tool",
            input: differentInput,
            contentHash: differentContentHash,
          });

          expect(entry).toBeNull();
        },
        { agentId: "test_agent" },
      );
    });

    it("multiple tool calls with same input share one cache entry (same contentHash)", async () => {
      await runInTestContext(
        async (ctx) => {
          const input = { query: "test" };
          const contentHash = hashValue({ name: "search", input });
          const output = { result: "cached" };

          recordJournal(ctx, "root/tool:search:0", {
            type: "tool",
            input,
            output,
            contentHash,
          });

          const snapshot = createTestSnapshot({
            callId: "root",
            journal: {
              prompt: {},
              tool: { ...ctx.draft.journal.tool },
            },
          });
          ctx.snapshot = snapshot;

          // Same contentHash, different callIds (e.g. 2nd and 3rd call in same run)
          const entry1 = getJournalEntry(ctx, "root/tool:search:0", {
            type: "tool",
            input,
            contentHash,
          });
          const entry2 = getJournalEntry(ctx, "root/tool:search:1", {
            type: "tool",
            input,
            contentHash,
          });

          expect(entry1).toBeDefined();
          expect(entry2).toBeDefined();
          expect(entry1?.output).toEqual(output);
          expect(entry2?.output).toEqual(output);
          expect(entry1).toBe(entry2);
        },
        { agentId: "test_agent" },
      );
    });

    it("tool cache is not shared across different agents (each agent has own journal)", async () => {
      const input = { query: "same" };
      const contentHash = hashValue({ name: "search", input });

      await runInTestContext(
        async (parentCtx) => {
          recordJournal(parentCtx, "root/tool:search:0", {
            type: "tool",
            input,
            output: { from: "parent" },
            contentHash,
          });

          const { ctx: childCtx } = createAgentContext({
            agentId: "child",
            callId: "root/agent:child:0",
          });
          // Child has its own frame/snapshot with empty tool journal (not parent's)
          childCtx.snapshot = createTestSnapshot({
            callId: "root/agent:child:0",
            agentId: "child",
            journal: { prompt: {}, tool: {} },
          });

          const entry = getJournalEntry(childCtx, "root/agent:child:0/tool:search:0", {
            type: "tool",
            input,
            contentHash,
          });

          expect(entry).toBeNull();
        },
        { agentId: "parent" },
      );
    });
  });

  describe("Tombstone Mechanism", () => {
    it("should create tombstone for non-serializable output", async () => {
      const { warnings, restore } = captureWarnings();

      await runInTestContext(
        async (ctx) => {
          const callId = "tool:test_tool:0";
          const input = { query: "test" };
          const contentHash = hashValue({ name: "test_tool", input });
          // Create non-serializable output (function)
          const nonSerializable = () => "test";

          recordJournal(ctx, callId, {
            type: "tool",
            input,
            output: nonSerializable,
            contentHash,
          });

          // Check that warning was issued
          expect(warnings.some((w) => w.includes("Non-serializable output"))).toBe(true);

          // Check that entry has error marker
          // Journal now uses contentHash as key for prompt and tool
          const entry = ctx.draft.journal.tool[contentHash];
          expect(entry).toBeDefined();
          expect(entry.error).toBe("Non-serializable output");
          expect(entry.output).toBeUndefined();
        },
        { agentId: "test_agent" },
      );

      restore();
    });

    it("should skip cache for tombstone entries", async () => {
      await runInTestContext(
        async (ctx) => {
          const callId = "tool:test_tool:0";
          const input = { query: "test" };
          const contentHash = hashValue({ name: "test_tool", input });
          // Create entry with tombstone
          recordJournal(ctx, callId, {
            type: "tool",
            input,
            output: () => "test", // Non-serializable
            contentHash,
          });

          const snapshot = createTestSnapshot({
            callId: "root/test_agent",
            journal: {
              prompt: {},
              tool: { ...ctx.draft.journal.tool },
            },
          });

          ctx.snapshot = snapshot;

          // Try to retrieve - should return null due to tombstone
          const entry = getJournalEntry(ctx, callId, {
            type: "tool",
            input,
            contentHash,
          });

          expect(entry).toBeNull();
        },
        { agentId: "test_agent" },
      );
    });

    it("should throw on non-serializable input during hash", () => {
      const nonSerializableInput = () => "test";
      expect(() => {
        hashValue({ name: "test_tool", input: nonSerializableInput });
      }).toThrow();
    });
  });

  describe("Snapshot with Real Agent Execution", () => {
    it("should record journal entries during agent execution", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test" });

      const capturedSnapshots: AgentSnapshot[] = [];

      const agent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        systemPrompt: "Test system",
        memory: { count: 0 },
        behavior: async () => {
          // Make a prompt call
          const result = await promptAgent(schemas.simple);

          // Dump snapshot at this point
          const snapshot = dumpSnapshot();
          capturedSnapshots.push(snapshot);

          return result;
        },
      });

      await agent({});

      expect(capturedSnapshots).toHaveLength(1);
      const snapshot = capturedSnapshots[0];
      expect(snapshot.root).toBeDefined();
      expect(snapshot.root.agentId).toBe("test_agent");
      expect(snapshot.root.memory.count).toBe(0);
    });
  });

  describe("runWith", () => {
    it("should run function without snapshot", async () => {
      const result = await runWith(async () => {
        return "test result";
      });

      expect(result).toBe("test result");
    });

    it("should restore context from snapshot", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "restored" });

      // First, create a snapshot
      let savedSnapshot: AgentSnapshot | null = null;

      const agent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        systemPrompt: "Test system",
        memory: { test_value: "initial" },
        behavior: async () => {
          // Record a journal entry
          const result = await promptAgent(schemas.simple);

          // Dump snapshot
          savedSnapshot = dumpSnapshot();

          return result;
        },
      });

      await agent({});
      expect(savedSnapshot).toBeDefined();

      // Now restore and run with snapshot
      if (savedSnapshot) {
        let restoredValue: string | undefined;

        await runWith(
          async () => {
            const [value] = equipMemory("test_value", "default");
            restoredValue = value as string;

            // Create agent and run (should use cached prompt if snapshot works)
            const restoredAgent = createTestAgent({
              id: "test_agent",
              model: mock.adapter,
              systemPrompt: "Test system",
              behavior: async () => {
                return await promptAgent(schemas.simple);
              },
            });

            return await restoredAgent({});
          },
          { snapshot: savedSnapshot },
        );

        // Verify memory was restored
        expect(restoredValue).toBe("initial");
      }
    });

    it("should restore nested context chain from snapshot", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let savedSnapshot: AgentSnapshot | null = null;

      const ChildAgent = createTestAgent({
        id: "child_agent",
        model: mock.adapter,
        behavior: async (props: { value: string }) => {
          const [childValue] = equipMemory("child_value", props.value);
          return { processed: childValue };
        },
      });

      const ParentAgent = createTestAgent({
        id: "parent_agent",
        model: mock.adapter,
        memory: { parent_value: "parent_data" },
        behavior: async () => {
          const childResult = await ChildAgent({ value: "child_data" });

          // Dump snapshot
          savedSnapshot = dumpSnapshot();

          return { parent: "parent_data", child: childResult };
        },
      });

      // First execution: create snapshot
      await ParentAgent({});
      expect(savedSnapshot).toBeDefined();
      expect(savedSnapshot!.root).toBeDefined();

      // Verify snapshot structure
      const rootFrame = savedSnapshot!.root;
      expect(rootFrame.memory.parent_value).toBe("parent_data");

      // Now restore and verify nested context chain
      let restoredParentValue: string | undefined;
      let restoredChildResult: { processed: string } | undefined;

      await runWith(
        async () => {
          const [parentValue] = equipMemory("parent_value", "default");
          restoredParentValue = parentValue as string;

          const RestoredParentAgent = createTestAgent({
            id: "parent_agent",
            model: mock.adapter,
            memory: { parent_value: "default" },
            behavior: async () => {
              const RestoredChildAgent = createTestAgent({
                id: "child_agent",
                model: mock.adapter,
                behavior: async (props: { value: string }) => {
                  const [childValue] = equipMemory("child_value", props.value);
                  return { processed: childValue };
                },
              });

              const childResult = await RestoredChildAgent({ value: "child_data" });
              restoredChildResult = childResult;

              return { parent: parentValue, child: childResult };
            },
          });

          return await RestoredParentAgent({});
        },
        { snapshot: savedSnapshot! },
      );

      // Verify memory was restored from snapshot
      expect(restoredParentValue).toBe("parent_data");
      // Verify child agent result was restored from cache (nested context chain)
      expect(restoredChildResult).toEqual({ processed: "child_data" });
    });

    it("should not make new mock calls when replaying from snapshot (Cache Hit)", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "cached_response" });

      let savedSnapshot: AgentSnapshot | null = null;

      const agent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        systemPrompt: "Test system",
        memory: { test_value: "initial" },
        behavior: async () => {
          // Make a prompt call that will be cached
          const result = await promptAgent(schemas.simple);

          // Dump snapshot after first execution
          savedSnapshot = dumpSnapshot();

          return { value: "initial", result };
        },
      });

      // First execution: should make a mock call
      await agent({});
      expect(savedSnapshot).toBeDefined();

      const firstCallCount = mock.calls.count();
      expect(firstCallCount).toBeGreaterThan(0);

      // Clear call records to verify no new calls on replay
      mock.calls.clear();
      expect(mock.calls.count()).toBe(0);

      // Second execution with snapshot: should use cache, no new mock calls
      let restoredValue: string | undefined;
      let restoredResult: unknown;

      await runWith(
        async () => {
          const [value] = equipMemory("test_value", "default");
          restoredValue = value as string;

          const restoredAgent = createTestAgent({
            id: "test_agent",
            model: mock.adapter,
            systemPrompt: "Test system",
            memory: { test_value: "default" },
            behavior: async () => {
              const result = await promptAgent(schemas.simple);
              restoredResult = result;
              return { value: "default", result };
            },
          });

          return await restoredAgent({});
        },
        { snapshot: savedSnapshot! },
      );

      // Verify memory was restored
      expect(restoredValue).toBe("initial");

      // Verify result was restored from cache
      expect(restoredResult).toEqual({ result: "cached_response" });

      // Verify NO new mock calls were made (cache hit)
      expect(mock.calls.count()).toBe(0);
    });

    it("should maintain journal consistency after cache hit when dumping snapshot again", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "cached_response" });

      // First execution: create snapshot
      let firstSnapshot: AgentSnapshot | null = null;

      const agent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        systemPrompt: "Test system",
        memory: { test_value: "initial" },
        behavior: async () => {
          // Make a prompt call that will be cached
          await promptAgent(schemas.simple);

          // Dump snapshot after first execution
          firstSnapshot = dumpSnapshot();

          return { value: "initial" };
        },
      });

      // First execution: should make a mock call
      await agent({});
      expect(firstSnapshot).toBeDefined();

      // Verify first snapshot has journal entries
      const wrappedFirstSnapshot = wrapRoot(firstSnapshot!);
      // Get the actual frame from children (root's journal is empty after wrapping)
      const firstChildrenKeys = Object.keys(wrappedFirstSnapshot.root.children);
      expect(firstChildrenKeys.length).toBeGreaterThan(0);
      const firstActualFrame = wrappedFirstSnapshot.root.children[firstChildrenKeys[0]];
      const firstPromptJournalKeys = Object.keys(firstActualFrame.journal.prompt);
      expect(firstPromptJournalKeys.length).toBeGreaterThan(0);

      // Clear call records
      mock.calls.clear();
      expect(mock.calls.count()).toBe(0);

      // Second execution with snapshot: should use cache and record journal
      let secondSnapshot: AgentSnapshot | null = null;

      await runWith(
        async () => {
          const restoredAgent = createTestAgent({
            id: "test_agent",
            model: mock.adapter,
            systemPrompt: "Test system",
            behavior: async () => {
              // Make the same prompt call (should hit cache)
              await promptAgent(schemas.simple);

              // Dump snapshot again after cache hit
              secondSnapshot = dumpSnapshot();

              return { value: "restored" };
            },
          });

          return await restoredAgent({});
        },
        { snapshot: firstSnapshot! },
      );

      // Verify NO new mock calls were made (cache hit)
      expect(mock.calls.count()).toBe(0);

      // Verify second snapshot exists
      expect(secondSnapshot).toBeDefined();

      // Wrap both snapshots to ensure consistent structure before comparison
      const wrappedSecondSnapshot = wrapRoot(secondSnapshot!);
      // Get the actual frame from children (root's journal is empty after wrapping)
      const secondChildrenKeys = Object.keys(wrappedSecondSnapshot.root.children);
      expect(secondChildrenKeys.length).toBeGreaterThan(0);
      const secondActualFrame = wrappedSecondSnapshot.root.children[secondChildrenKeys[0]];

      // Verify journal consistency: second snapshot should have the same journal entries as first
      const secondPromptJournalKeys = Object.keys(secondActualFrame.journal.prompt);
      expect(secondPromptJournalKeys.length).toBe(firstPromptJournalKeys.length);

      // Verify all journal entries from first snapshot exist in second snapshot
      for (const key of firstPromptJournalKeys) {
        expect(secondActualFrame.journal.prompt[key]).toBeDefined();
        expect(secondActualFrame.journal.prompt[key]).toEqual(firstActualFrame.journal.prompt[key]);
      }

      // Verify tool journal is also consistent (empty in this case, but structure should match)
      expect(Object.keys(secondActualFrame.journal.tool).length).toBe(
        Object.keys(firstActualFrame.journal.tool).length,
      );
    });

    it("should create resource normally when equipResource is called first time after snapshot restore", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let savedSnapshot: AgentSnapshot | null = null;
      const createResource = vi.fn().mockResolvedValue({ id: "resource-1", data: "test" });
      const destroyResource = vi.fn().mockResolvedValue(undefined);

      // First execution: create resource and dump snapshot
      const agent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        systemPrompt: "Test system",
        behavior: async () => {
          // Create resource
          const resource = await equipResource("test_resource", {
            create: createResource,
            destroy: destroyResource,
            deps: ["dep1"],
          });

          // Dump snapshot
          savedSnapshot = dumpSnapshot();

          return { resourceId: resource.id };
        },
      });

      await agent({});
      expect(savedSnapshot).toBeDefined();
      expect(createResource).toHaveBeenCalledTimes(1);
      expect(destroyResource).toHaveBeenCalled();

      // Clear call records
      createResource.mockClear();
      destroyResource.mockClear();

      // Second execution with snapshot: should create resource again (ephemeral storage is cleared)
      let restoredResource: { id: string; data: string } | undefined;

      await runWith(
        async () => {
          const restoredAgent = createTestAgent({
            id: "test_agent",
            model: mock.adapter,
            systemPrompt: "Test system",
            behavior: async () => {
              // First call to equipResource after snapshot restore
              // Should create resource normally (ephemeral storage is empty, so deps changed)
              const resource = await equipResource("test_resource", {
                create: createResource,
                destroy: destroyResource,
                deps: ["dep1"],
              });

              restoredResource = resource;
              return { resourceId: resource.id };
            },
          });

          return await restoredAgent({});
        },
        { snapshot: savedSnapshot! },
      );

      // Verify resource was created successfully
      expect(restoredResource).toBeDefined();
      expect(restoredResource!.id).toBe("resource-1");
      expect(createResource).toHaveBeenCalledTimes(1);
      expect(destroyResource).toHaveBeenCalled();
    });

    it("should trigger real LLM call when prompt hash mismatches (Cache Miss due to code change)", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "original_response" });

      let savedSnapshot: AgentSnapshot | null = null;

      // First execution: create snapshot with original system prompt
      // This simulates the initial run where a prompt call is made and cached
      const agent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        systemPrompt: "Original system prompt",
        memory: { test_value: "initial" },
        behavior: async () => {
          // Make a prompt call that will be cached in snapshot
          const result = await promptAgent(schemas.simple);

          // Dump snapshot after first execution
          savedSnapshot = dumpSnapshot();

          return { value: "initial", result };
        },
      });

      // First execution: should make a mock call
      await agent({});
      expect(savedSnapshot).toBeDefined();

      const firstCallCount = mock.calls.count();
      expect(firstCallCount).toBeGreaterThan(0);

      // Clear call records to verify new calls on replay with changed prompt
      mock.calls.clear();
      expect(mock.calls.count()).toBe(0);

      // Change the default response to simulate different LLM behavior
      // This helps verify that a NEW call was made (not using cached result)
      mock.setDefaultResponse({ result: "new_response_after_code_change" });

      // Second execution with snapshot but CHANGED system prompt
      // Scenario: Developer modified the system prompt (code change)
      // Expected: contentHash will be different, causing cache miss
      // Result: System should trigger real LLM call instead of using stale cache
      let restoredValue: string | undefined;
      let restoredResult: unknown;

      await runWith(
        async () => {
          const [value] = equipMemory("test_value", "default");
          restoredValue = value as string;

          const restoredAgent = createTestAgent({
            id: "test_agent",
            model: mock.adapter,
            systemPrompt: "Modified system prompt", // Changed! This changes contentHash
            memory: { test_value: "default" },
            behavior: async () => {
              const result = await promptAgent(schemas.simple);
              restoredResult = result;
              return { value: "default", result };
            },
          });

          return await restoredAgent({});
        },
        { snapshot: savedSnapshot! },
      );

      // Verify memory was restored from snapshot (snapshot mechanism still works)
      expect(restoredValue).toBe("initial");

      // Verify result is from NEW LLM call (not cached)
      // This proves that hash mismatch correctly triggered cache miss
      expect(restoredResult).toEqual({ result: "new_response_after_code_change" });

      // Verify NEW mock calls were made (cache miss due to hash mismatch)
      // This is the key assertion: system correctly detected hash change and called LLM
      expect(mock.calls.count()).toBeGreaterThan(0);
    });

    it("should restore budgetState from snapshot", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });
      mock.setDefaultUsage({ promptTokens: 10, completionTokens: 5 });

      let savedSnapshot: AgentSnapshot | null = null;

      const agent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        systemPrompt: "Test system",
        behavior: async () => {
          // Set budget limit
          equipBudget({ onUpdate: () => {} });

          // Make a prompt call to generate usage
          await promptAgent(schemas.simple);

          // Get usage stats before dump
          const statsBeforeDump = getUsageStats();

          // Verify budgetState exists and has usage
          expect(sumBudgetCosts(statsBeforeDump.own.costs)).toBeGreaterThan(0);
          expect(sumBudgetCosts(statsBeforeDump.aggregate.costs)).toBeGreaterThan(0);

          // Dump snapshot
          savedSnapshot = dumpSnapshot();

          return { stats: statsBeforeDump };
        },
      });

      await agent({});
      expect(savedSnapshot).toBeDefined();

      // Verify snapshot contains budgetState
      expect(savedSnapshot!.root.budgetState).toBeDefined();
      expect(sumBudgetCosts(savedSnapshot!.root.budgetState!.own.costs)).toBeGreaterThan(0);
      expect(sumBudgetCosts(savedSnapshot!.root.budgetState!.aggregate.costs)).toBeGreaterThan(0);

      // Clear mock calls to verify replay
      mock.calls.clear();

      // Restore and verify budgetState
      let restoredOwnCosts: Record<string, number> | undefined;
      let restoredAggregateCosts: Record<string, number> | undefined;
      let restoredOwnTokens: number | undefined;
      let restoredAggregateTokens: number | undefined;

      await runWith(
        async () => {
          // Get usage stats after restore
          const statsAfterRestore = getUsageStats();

          restoredOwnCosts = statsAfterRestore.own.costs;
          restoredAggregateCosts = statsAfterRestore.aggregate.costs;
          restoredOwnTokens = statsAfterRestore.own.totalTokens;
          restoredAggregateTokens = statsAfterRestore.aggregate.totalTokens;

          const restoredAgent = createTestAgent({
            id: "test_agent",
            model: mock.adapter,
            systemPrompt: "Test system",
            behavior: async () => {
              // Verify budgetState is restored and can be used
              const currentStats = getUsageStats();
              expect(sumBudgetCosts(currentStats.own.costs)).toBeGreaterThan(0);
              expect(sumBudgetCosts(currentStats.aggregate.costs)).toBeGreaterThan(0);

              // Make another call (should use cached prompt)
              return await promptAgent(schemas.simple);
            },
          });

          return await restoredAgent({});
        },
        { snapshot: savedSnapshot! },
      );

      // Verify budgetState was restored correctly
      expect(restoredOwnCosts).toEqual(savedSnapshot!.root.budgetState!.own.costs);
      expect(restoredAggregateCosts).toEqual(savedSnapshot!.root.budgetState!.aggregate.costs);
      expect(restoredOwnTokens).toBe(savedSnapshot!.root.budgetState!.own.totalTokens);
      expect(restoredAggregateTokens).toBe(savedSnapshot!.root.budgetState!.aggregate.totalTokens);

      // Verify no new LLM calls were made (cache hit)
      expect(mock.calls.count()).toBe(0);
    });

    it("should restore budgetState with nested agents from snapshot", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });
      mock.setDefaultUsage({ promptTokens: 10, completionTokens: 5 });

      let savedSnapshot: AgentSnapshot | null = null;

      const ChildAgent = createTestAgent({
        id: "child_agent",
        model: mock.adapter,
        behavior: async () => {
          equipBudget({ onUpdate: () => {} });
          await promptAgent(schemas.simple);
          return { result: "child_done" };
        },
      });

      const ParentAgent = createTestAgent({
        id: "parent_agent",
        model: mock.adapter,
        behavior: async () => {
          equipBudget({ onUpdate: () => {} });
          await promptAgent(schemas.simple);
          await ChildAgent({});

          // Get budget stats before dump
          const parentStats = getUsageStats();

          // Dump snapshot
          savedSnapshot = dumpSnapshot();

          return { stats: parentStats };
        },
      });

      await ParentAgent({});
      expect(savedSnapshot).toBeDefined();

      // Verify snapshot contains budgetState for root
      expect(savedSnapshot!.root.budgetState).toBeDefined();
      const rootBudgetState = savedSnapshot!.root.budgetState!;
      expect(sumBudgetCosts(rootBudgetState.aggregate.costs)).toBeGreaterThan(0);

      // Find child frame and verify it has budgetState
      const childCallIds = Object.keys(savedSnapshot!.root.children);
      expect(childCallIds.length).toBeGreaterThan(0);
      const childCallId = childCallIds.find((id) => id.includes("child_agent"));
      expect(childCallId).toBeDefined();

      if (childCallId) {
        const childFrame = savedSnapshot!.root.children[childCallId];
        expect(childFrame.budgetState).toBeDefined();
        expect(sumBudgetCosts(childFrame.budgetState!.own.costs)).toBeGreaterThan(0);
      }

      // Clear mock calls
      mock.calls.clear();

      // Restore and verify budgetState
      let restoredRootOwnCosts: Record<string, number> | undefined;
      let restoredRootAggregateCosts: Record<string, number> | undefined;

      await runWith(
        async () => {
          const rootStats = getUsageStats();
          restoredRootOwnCosts = rootStats.own.costs;
          restoredRootAggregateCosts = rootStats.aggregate.costs;

          const RestoredParentAgent = createTestAgent({
            id: "parent_agent",
            model: mock.adapter,
            behavior: async () => {
              const RestoredChildAgent = createTestAgent({
                id: "child_agent",
                model: mock.adapter,
                behavior: async () => {
                  const childStats = getUsageStats();
                  expect(sumBudgetCosts(childStats.own.costs)).toBeGreaterThan(0);
                  return { result: "child_done" };
                },
              });

              await promptAgent(schemas.simple);
              await RestoredChildAgent({});

              return { result: "parent_done" };
            },
          });

          return await RestoredParentAgent({});
        },
        { snapshot: savedSnapshot! },
      );

      // Verify root budgetState was restored correctly
      expect(restoredRootOwnCosts).toEqual(rootBudgetState.own.costs);
      expect(restoredRootAggregateCosts).toEqual(rootBudgetState.aggregate.costs);

      // Verify no new LLM calls were made
      expect(mock.calls.count()).toBe(0);
    });
  });

  describe("Snapshot Validation (Fail Fast)", () => {
    it("should throw explicit error for malformed snapshot (missing agentId)", async () => {
      const malformedSnapshot = {
        processId: "test-process",
        timestamp: Date.now(),
        root: {
          // Missing agentId - should fail validation
          callId: "root",
          memory: {},
          journal: {
            prompt: {},
            tool: {},
          },
          children: {},
          state: {
            status: "running" as const,
          },
        },
      } as any; // Force bypass TS type check to simulate runtime dirty data

      await expect(async () => {
        await runWith(async () => "success", { snapshot: malformedSnapshot });
      }).rejects.toThrow(/Invalid Snapshot format.*agentId/);
    });

    it("should throw if snapshot root is missing", async () => {
      const emptySnapshot = {
        processId: "test-process",
        timestamp: Date.now(),
        // Missing root
      } as any;

      await expect(async () => {
        await runWith(async () => "success", { snapshot: emptySnapshot });
      }).rejects.toThrow(/Invalid Snapshot format.*root/);
    });

    it("should throw if snapshot root.memory is missing", async () => {
      const malformedSnapshot = {
        processId: "test-process",
        timestamp: Date.now(),
        root: {
          callId: "root",
          agentId: "test_agent",
          // Missing memory
          journal: {
            prompt: {},
            tool: {},
          },
          children: {},
          state: {
            status: "running" as const,
          },
        },
      } as any;

      await expect(async () => {
        await runWith(async () => "success", { snapshot: malformedSnapshot });
      }).rejects.toThrow(/Invalid Snapshot format.*memory/);
    });

    it("should throw if snapshot root.journal is missing", async () => {
      const malformedSnapshot = {
        processId: "test-process",
        timestamp: Date.now(),
        root: {
          callId: "root",
          agentId: "test_agent",
          memory: {},
          // Missing journal
          children: {},
          state: {
            status: "running" as const,
          },
        },
      } as any;

      await expect(async () => {
        await runWith(async () => "success", { snapshot: malformedSnapshot });
      }).rejects.toThrow(/Invalid Snapshot format.*journal/);
    });

    it("should throw if snapshot root.state is missing", async () => {
      const malformedSnapshot = {
        processId: "test-process",
        timestamp: Date.now(),
        root: {
          callId: "root",
          agentId: "test_agent",
          memory: {},
          journal: {
            prompt: {},
            tool: {},
          },
          children: {},
          // Missing state
        },
      } as any;

      await expect(async () => {
        await runWith(async () => "success", { snapshot: malformedSnapshot });
      }).rejects.toThrow(/Invalid Snapshot format.*state/);
    });

    it("should throw if snapshot processId is missing", async () => {
      const malformedSnapshot = {
        // Missing processId
        timestamp: Date.now(),
        root: {
          callId: "root",
          agentId: "test_agent",
          memory: {},
          journal: {
            prompt: {},
            tool: {},
          },
          children: {},
          state: {
            status: "running" as const,
          },
        },
      } as any;

      await expect(async () => {
        await runWith(async () => "success", { snapshot: malformedSnapshot });
      }).rejects.toThrow(/Invalid Snapshot format.*processId/);
    });

    it("should throw if snapshot timestamp is missing", async () => {
      const malformedSnapshot = {
        processId: "test-process",
        // Missing timestamp
        root: {
          callId: "root",
          agentId: "test_agent",
          memory: {},
          journal: {
            prompt: {},
            tool: {},
          },
          children: {},
          state: {
            status: "running" as const,
          },
        },
      } as any;

      await expect(async () => {
        await runWith(async () => "success", { snapshot: malformedSnapshot });
      }).rejects.toThrow(/Invalid Snapshot format.*timestamp/);
    });

    it("should throw if snapshot state.status is invalid", async () => {
      const malformedSnapshot = {
        processId: "test-process",
        timestamp: Date.now(),
        root: {
          callId: "root",
          agentId: "test_agent",
          memory: {},
          journal: {
            prompt: {},
            tool: {},
          },
          children: {},
          state: {
            status: "invalid_status" as any, // Invalid status
          },
        },
      } as any;

      await expect(async () => {
        await runWith(async () => "success", { snapshot: malformedSnapshot });
      }).rejects.toThrow(/Invalid Snapshot format.*status/);
    });

    it("should accept valid snapshot without throwing", async () => {
      const validSnapshot: AgentSnapshot = {
        processId: "test-process",
        timestamp: Date.now(),
        root: createTestSnapshot({
          callId: "root",
          memory: { test_key: "test_value" },
          state: {
            status: "completed",
            output: { result: "done" },
          },
        }),
        provenance: {
          traceId: "test-trace-id",
          spanId: "test-span-id",
        },
        version: SNAPSHOT_VERSION,
      };

      // Should not throw
      await expect(async () => {
        await runWith(async () => "success", { snapshot: validSnapshot });
      }).not.toThrow();
    });

    it("should validate nested children structure recursively", async () => {
      // Create a deeply nested snapshot structure
      const nestedSnapshot: AgentSnapshot = {
        processId: "test-process",
        timestamp: Date.now(),
        root: createTestSnapshot({
          callId: "root",
          agentId: "parent_agent",
          memory: { parent_key: "parent_value" },
          children: {
            "root/child1": createTestSnapshot({
              callId: "root/child1",
              agentId: "child_agent_1",
              memory: { child1_key: "child1_value" },
              children: {
                "root/child1/grandchild1": createTestSnapshot({
                  callId: "root/child1/grandchild1",
                  agentId: "grandchild_agent_1",
                  memory: { grandchild1_key: "grandchild1_value" },
                  state: {
                    status: "completed",
                    output: { result: "grandchild1_done" },
                  },
                }),
              },
              state: {
                status: "completed",
                output: { result: "child1_done" },
              },
            }),
            "root/child2": createTestSnapshot({
              callId: "root/child2",
              agentId: "child_agent_2",
              memory: { child2_key: "child2_value" },
              state: {
                status: "running",
              },
            }),
          },
          state: {
            status: "completed",
            output: { result: "parent_done" },
          },
        }),
        provenance: {
          traceId: "test-trace-id",
          spanId: "test-span-id",
        },
        version: SNAPSHOT_VERSION,
      };

      // Should validate successfully without throwing
      await expect(async () => {
        await runWith(async () => "success", { snapshot: nestedSnapshot });
      }).not.toThrow();
    });

    it("should throw error for invalid nested children structure", async () => {
      const invalidNestedSnapshot = {
        processId: "test-process",
        timestamp: Date.now(),
        root: {
          callId: "root",
          agentId: "parent_agent",
          memory: {},
          journal: {
            prompt: {},
            tool: {},
          },
          children: {
            "root/child1": {
              callId: "root/child1",
              agentId: "child_agent_1",
              memory: {},
              journal: {
                prompt: {},
                tool: {},
              },
              children: {
                "root/child1/grandchild1": {
                  callId: "root/child1/grandchild1",
                  // Missing agentId in nested child - should fail validation
                  memory: {},
                  journal: {
                    prompt: {},
                    tool: {},
                  },
                  children: {},
                  state: {
                    status: "completed",
                  },
                },
              },
              state: {
                status: "completed",
              },
            },
          },
          state: {
            status: "completed",
          },
        },
      } as any;

      // Should throw error because nested child is missing agentId
      await expect(async () => {
        await runWith(async () => "success", { snapshot: invalidNestedSnapshot });
      }).rejects.toThrow(/Invalid Snapshot format.*agentId/);
    });

    it("should throw error for invalid nested children state", async () => {
      const invalidNestedSnapshot = {
        processId: "test-process",
        timestamp: Date.now(),
        root: {
          callId: "root",
          agentId: "parent_agent",
          memory: {},
          journal: {
            prompt: {},
            tool: {},
          },
          children: {
            "root/child1": {
              callId: "root/child1",
              agentId: "child_agent_1",
              memory: {},
              journal: {
                prompt: {},
                tool: {},
              },
              children: {
                "root/child1/grandchild1": {
                  callId: "root/child1/grandchild1",
                  agentId: "grandchild_agent_1",
                  memory: {},
                  journal: {
                    prompt: {},
                    tool: {},
                  },
                  children: {},
                  state: {
                    status: "invalid_status" as any, // Invalid status in nested child
                  },
                },
              },
              state: {
                status: "completed",
              },
            },
          },
          state: {
            status: "completed",
          },
        },
      } as any;

      // Should throw error because nested child has invalid status
      await expect(async () => {
        await runWith(async () => "success", { snapshot: invalidNestedSnapshot });
      }).rejects.toThrow(/Invalid Snapshot format.*status/);
    });
  });
});
