/**
 * Schema Recursion Tests
 *
 * Tests to verify that the recursive schema definition correctly validates
 * nested children structures at any depth, with focus on:
 * - Deep recursion validation (runtime stability)
 * - Error path reporting (debugging friendliness)
 * - BudgetState validation (recent fix)
 */

import { describe, expect, it } from "vitest";
import type { AgentFrameSnapshot, JournalEntry } from "../../context/snapshot";
import type { BudgetState, UsageStats } from "../../domain/budget";
import { SNAPSHOT_VERSION } from "../../shared/const";
import { getSnapshotSchema } from "../schema";
import type { AgentSnapshot } from "../type";

// ============ Helper Functions ============

/**
 * Create usage stats for testing
 */
function createUsageStats(overrides?: Partial<UsageStats>): UsageStats {
  return {
    costs: {},
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    callCount: 0,
    items: [],
    ...overrides,
  };
}

/**
 * Create budget state for testing
 */
function createBudgetState(overrides?: Partial<BudgetState>): BudgetState {
  return {
    own: createUsageStats(),
    aggregate: createUsageStats(),
    ...overrides,
  };
}

/**
 * Create agent frame snapshot for testing
 * Supports recursive children structure
 */
function createAgentFrame(
  callId: string,
  agentId: string,
  options?: {
    memory?: Record<string, unknown>;
    journal?: { prompt?: Record<string, unknown>; tool?: Record<string, unknown> };
    children?: Record<string, AgentFrameSnapshot>;
    state?: { status: "running" | "completed" | "failed"; output?: unknown; error?: unknown };
    budgetState?: BudgetState;
  },
): AgentFrameSnapshot {
  return {
    callId,
    agentId,
    memory: options?.memory ?? {},
    journal: {
      prompt: (options?.journal?.prompt ?? {}) as Record<string, JournalEntry>,
      tool: (options?.journal?.tool ?? {}) as Record<string, JournalEntry>,
    },
    children: options?.children ?? {},
    state: options?.state ?? { status: "completed" },
    budgetState: options?.budgetState ?? createBudgetState(),
  };
}

/**
 * Create agent snapshot for testing
 */
function createAgentSnapshot(
  root: AgentFrameSnapshot,
  options?: {
    processId?: string;
    timestamp?: number;
    provenance?: { traceId?: string; spanId?: string };
    version?: number;
    metadata?: Record<string, unknown>;
  },
): AgentSnapshot {
  return {
    processId: options?.processId ?? "test-process",
    timestamp: options?.timestamp ?? Date.now(),
    root,
    provenance: {
      traceId: options?.provenance?.traceId ?? "test-trace-id",
      spanId: options?.provenance?.spanId ?? "test-span-id",
    },
    version: options?.version ?? SNAPSHOT_VERSION,
    metadata: options?.metadata,
  };
}

// ============ Tests ============

describe("Schema Recursion Validation", () => {
  it("should validate deeply nested children structure (3 levels)", () => {
    const schema = getSnapshotSchema();

    // Build 3-level nested structure using helper functions
    const level3 = createAgentFrame("root/level2/level3", "level3", {
      memory: { level: 3 },
    });

    const level2 = createAgentFrame("root/level2", "level2", {
      memory: { level: 2 },
      children: {
        "root/level2/level3": level3,
      },
    });

    const root = createAgentFrame("root", "level1", {
      memory: { level: 1 },
      children: {
        "root/level2": level2,
      },
    });

    const snapshot = createAgentSnapshot(root);

    const result = schema.safeParse(snapshot);
    expect(result.success).toBe(true);
  });

  it("should detect errors in nested children with accurate path reporting", () => {
    const schema = getSnapshotSchema();

    // Create invalid snapshot: missing agentId at level 3
    const invalidSnapshot = {
      processId: "test-process",
      timestamp: Date.now(),
      root: {
        callId: "root",
        agentId: "parent",
        memory: {},
        journal: { prompt: {}, tool: {} },
        children: {
          "root/child1": {
            callId: "root/child1",
            agentId: "child1",
            memory: {},
            journal: { prompt: {}, tool: {} },
            children: {
              "root/child1/grandchild": {
                callId: "root/child1/grandchild",
                // Missing agentId - should fail
                memory: {},
                journal: { prompt: {}, tool: {} },
                children: {},
                state: { status: "completed" },
                budgetState: createBudgetState(),
              },
            },
            state: { status: "completed" },
            budgetState: createBudgetState(),
          },
        },
        state: { status: "completed" },
        budgetState: createBudgetState(),
      },
    } as any;

    const result = schema.safeParse(invalidSnapshot);
    expect(result.success).toBe(false);
    if (!result.success) {
      // Verify error path includes both grandchild and agentId
      const hasCorrectPath = result.error.errors.some(
        (e) => e.path.join(".").includes("grandchild") && e.path.includes("agentId"),
      );
      expect(hasCorrectPath).toBe(true);
    }
  });

  it("should validate budgetState in nested structure", () => {
    const schema = getSnapshotSchema();

    // Create snapshot with budgetState at each level
    const child = createAgentFrame("root/child", "child-agent", {
      budgetState: createBudgetState({
        own: createUsageStats({
          costs: { micro_usd: 10_000 },
          totalTokens: 100,
          promptTokens: 60,
          completionTokens: 40,
          callCount: 1,
        }),
        aggregate: createUsageStats({
          costs: { micro_usd: 10_000 },
          totalTokens: 100,
          promptTokens: 60,
          completionTokens: 40,
          callCount: 1,
        }),
      }),
    });

    const root = createAgentFrame("root", "root-agent", {
      budgetState: createBudgetState({
        own: createUsageStats({
          costs: { micro_usd: 20_000 },
          totalTokens: 200,
          promptTokens: 120,
          completionTokens: 80,
          callCount: 2,
        }),
        aggregate: createUsageStats({
          costs: { micro_usd: 30_000 }, // own + child
          totalTokens: 300, // own + child
          promptTokens: 180,
          completionTokens: 120,
          callCount: 3,
        }),
      }),
      children: {
        "root/child": child,
      },
    });

    const snapshot = createAgentSnapshot(root);

    const result = schema.safeParse(snapshot);
    expect(result.success).toBe(true);
  });

  it("should detect errors in budgetState structure", () => {
    const schema = getSnapshotSchema();

    // Create invalid snapshot: missing aggregate in budgetState
    const invalidSnapshot = {
      processId: "test-process",
      timestamp: Date.now(),
      root: {
        callId: "root",
        agentId: "root-agent",
        memory: {},
        journal: { prompt: {}, tool: {} },
        children: {},
        state: { status: "completed" },
        budgetState: {
          own: createUsageStats(),
          // Missing aggregate - should fail
        },
      },
    } as any;

    const result = schema.safeParse(invalidSnapshot);
    expect(result.success).toBe(false);
    if (!result.success) {
      // Verify error path points to budgetState.aggregate
      const hasCorrectPath = result.error.errors.some(
        (e) => e.path.includes("budgetState") && e.path.includes("aggregate"),
      );
      expect(hasCorrectPath).toBe(true);
    }
  });

  it("should detect errors in deeply nested budgetState", () => {
    const schema = getSnapshotSchema();

    // Create invalid snapshot: invalid budgetState at level 3
    const invalidSnapshot = {
      processId: "test-process",
      timestamp: Date.now(),
      root: {
        callId: "root",
        agentId: "root-agent",
        memory: {},
        journal: { prompt: {}, tool: {} },
        children: {
          "root/child1": {
            callId: "root/child1",
            agentId: "child1",
            memory: {},
            journal: { prompt: {}, tool: {} },
            children: {
              "root/child1/grandchild": {
                callId: "root/child1/grandchild",
                agentId: "grandchild",
                memory: {},
                journal: { prompt: {}, tool: {} },
                children: {},
                state: { status: "completed" },
                budgetState: {
                  own: createUsageStats(),
                  // Missing aggregate - should fail
                },
              },
            },
            state: { status: "completed" },
            budgetState: createBudgetState(),
          },
        },
        state: { status: "completed" },
        budgetState: createBudgetState(),
      },
    } as any;

    const result = schema.safeParse(invalidSnapshot);
    expect(result.success).toBe(false);
    if (!result.success) {
      // Verify error path correctly identifies nested budgetState error
      const hasCorrectPath = result.error.errors.some(
        (e) =>
          e.path.join(".").includes("grandchild") &&
          e.path.includes("budgetState") &&
          e.path.includes("aggregate"),
      );
      expect(hasCorrectPath).toBe(true);
    }
  });

  it("should validate budgetState when inserting new agent between nested agents", () => {
    const schema = getSnapshotSchema();

    // Scenario: Parent -> Child1 -> Child2
    // After restore, insert NewChild between Child1 and Child2
    // This test verifies that budgetState structure remains valid when restructuring the tree

    // Original structure: Child2 (deepest)
    const child2 = createAgentFrame("root/child1/child2", "child2-agent", {
      budgetState: createBudgetState({
        own: createUsageStats({
          costs: { micro_usd: 10_000 },
          totalTokens: 100,
          promptTokens: 60,
          completionTokens: 40,
          callCount: 1,
        }),
        aggregate: createUsageStats({
          costs: { micro_usd: 10_000 },
          totalTokens: 100,
          promptTokens: 60,
          completionTokens: 40,
          callCount: 1,
        }),
      }),
    });

    // Child1 (middle level)
    const child1 = createAgentFrame("root/child1", "child1-agent", {
      budgetState: createBudgetState({
        own: createUsageStats({
          costs: { micro_usd: 20_000 },
          totalTokens: 200,
          promptTokens: 120,
          completionTokens: 80,
          callCount: 2,
        }),
        aggregate: createUsageStats({
          costs: { micro_usd: 30_000 }, // own (0.02) + child2 (0.01)
          totalTokens: 300,
          promptTokens: 180,
          completionTokens: 120,
          callCount: 3,
        }),
      }),
      children: {
        "root/child1/child2": child2,
      },
    });

    // Root (top level)
    const root = createAgentFrame("root", "root-agent", {
      budgetState: createBudgetState({
        own: createUsageStats({
          costs: { micro_usd: 10_000 },
          totalTokens: 100,
          promptTokens: 60,
          completionTokens: 40,
          callCount: 1,
        }),
        aggregate: createUsageStats({
          costs: { micro_usd: 40_000 }, // own (0.01) + child1 aggregate (0.03)
          totalTokens: 400,
          promptTokens: 240,
          completionTokens: 160,
          callCount: 4,
        }),
      }),
      children: {
        "root/child1": child1,
      },
    });

    // Original snapshot (before inserting new agent)
    const originalSnapshot = createAgentSnapshot(root);
    const originalResult = schema.safeParse(originalSnapshot);
    expect(originalResult.success).toBe(true);

    // Simulate inserting new agent between Child1 and Child2
    // New structure: Parent -> Child1 -> NewChild -> Child2
    //
    // IMPORTANT: When inserting a new agent in the middle, budgetState aggregate values
    // need to be recalculated:
    // - NewChild.aggregate = NewChild.own + Child2.aggregate
    // - Child1.aggregate = Child1.own + NewChild.aggregate (updated)
    // - Root.aggregate = Root.own + Child1.aggregate (updated)
    const newChild = createAgentFrame("root/child1/newchild", "newchild-agent", {
      budgetState: createBudgetState({
        own: createUsageStats({
          costs: { micro_usd: 5_000 },
          totalTokens: 50,
          promptTokens: 30,
          completionTokens: 20,
          callCount: 1,
        }),
        aggregate: createUsageStats({
          // own (0.005) + child2 aggregate (0.01)
          costs: { micro_usd: 15_000 },
          totalTokens: 150,
          promptTokens: 90,
          completionTokens: 60,
          callCount: 2,
        }),
      }),
      children: {
        // Child2 is now a child of NewChild (callId needs to be updated)
        "root/child1/newchild/child2": {
          ...child2,
          callId: "root/child1/newchild/child2", // Update callId to reflect new parent
        },
      },
    });

    // Updated Child1 with NewChild inserted
    const updatedChild1 = createAgentFrame("root/child1", "child1-agent", {
      budgetState: createBudgetState({
        own: createUsageStats({
          costs: { micro_usd: 20_000 },
          totalTokens: 200,
          promptTokens: 120,
          completionTokens: 80,
          callCount: 2,
        }),
        aggregate: createUsageStats({
          // own (0.02) + newChild aggregate (0.015)
          costs: { micro_usd: 35_000 },
          totalTokens: 350,
          promptTokens: 210,
          completionTokens: 140,
          callCount: 4,
        }),
      }),
      children: {
        "root/child1/newchild": newChild,
      },
    });

    // Updated root with new structure
    const updatedRoot = createAgentFrame("root", "root-agent", {
      budgetState: createBudgetState({
        own: createUsageStats({
          costs: { micro_usd: 10_000 },
          totalTokens: 100,
          promptTokens: 60,
          completionTokens: 40,
          callCount: 1,
        }),
        aggregate: createUsageStats({
          // own (0.01) + updated child1 aggregate (0.035)
          costs: { micro_usd: 45_000 },
          totalTokens: 450,
          promptTokens: 270,
          completionTokens: 180,
          callCount: 5,
        }),
      }),
      children: {
        "root/child1": updatedChild1,
      },
    });

    // Snapshot after inserting new agent
    const updatedSnapshot = createAgentSnapshot(updatedRoot);
    const updatedResult = schema.safeParse(updatedSnapshot);

    expect(updatedResult.success).toBe(true);

    if (updatedResult.success) {
      // Verify all budgetState structures are valid and correctly aggregated
      const validatedSnapshot = updatedResult.data;

      // Root budgetState: should include all nested consumption
      expect(validatedSnapshot.root.budgetState).toBeDefined();
      expect(validatedSnapshot.root.budgetState.own.costs.micro_usd).toBe(10_000);
      expect(validatedSnapshot.root.budgetState.aggregate.costs.micro_usd).toBe(45_000);

      // Child1 budgetState: should include NewChild's aggregate
      const child1Frame = validatedSnapshot.root.children["root/child1"];
      expect(child1Frame).toBeDefined();
      expect(child1Frame.budgetState).toBeDefined();
      expect(child1Frame.budgetState.own.costs.micro_usd).toBe(20_000);
      expect(child1Frame.budgetState.aggregate.costs.micro_usd).toBe(35_000);

      // NewChild budgetState: should include Child2's aggregate
      const newChildFrame = child1Frame.children["root/child1/newchild"];
      expect(newChildFrame).toBeDefined();
      expect(newChildFrame.budgetState).toBeDefined();
      expect(newChildFrame.budgetState.own.costs.micro_usd).toBe(5_000);
      expect(newChildFrame.budgetState.aggregate.costs.micro_usd).toBe(15_000);

      // Child2 budgetState: should remain unchanged (no children)
      const child2Frame = newChildFrame.children["root/child1/newchild/child2"];
      expect(child2Frame).toBeDefined();
      expect(child2Frame.budgetState).toBeDefined();
      expect(child2Frame.budgetState.own.costs.micro_usd).toBe(10_000);
      expect(child2Frame.budgetState.aggregate.costs.micro_usd).toBe(10_000);

      // Verify the aggregation chain is correct:
      // Root.aggregate (0.045) = Root.own (0.01) + Child1.aggregate (0.035)
      // Child1.aggregate (0.035) = Child1.own (0.02) + NewChild.aggregate (0.015)
      // NewChild.aggregate (0.015) = NewChild.own (0.005) + Child2.aggregate (0.01)
      // Child2.aggregate (0.01) = Child2.own (0.01) [no children]
    }
  });
});
