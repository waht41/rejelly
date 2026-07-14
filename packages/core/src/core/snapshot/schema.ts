/**
 * Snapshot Schema Validation
 *
 * Provides Zod schemas for validating snapshot structure at runtime.
 * This ensures Fail Fast behavior: if snapshot is corrupted, we throw
 * immediately rather than silently failing and making expensive LLM calls.
 */

import { z } from "zod";
import { SNAPSHOT_VERSION } from "../shared/const";

/**
 * Get snapshot schema for validation
 *
 * Defines and returns the Zod schema for AgentSnapshot validation.
 * All schema definitions are contained within this function.
 *
 * @returns Zod schema for AgentSnapshot
 */
export function getSnapshotSchema() {
  /**
   * Journal Entry Schema
   * Validates individual journal entries for prompt and tool calls
   */
  const JournalEntrySchema = z.object({
    output: z.unknown(),
    contentHash: z.string(),
    error: z.string().optional(),
  });

  /**
   * Agent Frame Snapshot Schema
   *
   * Validates the structure of a single agent frame snapshot.
   * This is a recursive structure (children can contain more frames),
   * using z.lazy() to handle the recursion properly.
   */
  /**
   * Usage Stats Schema
   * Validates usage statistics structure
   */
  const UsageStatsSchema = z.object({
    costs: z.record(z.number()),
    totalTokens: z.number(),
    promptTokens: z.number(),
    completionTokens: z.number(),
    callCount: z.number(),
    details: z.record(z.number()).optional(),
    items: z.array(z.unknown()),
  });

  /**
   * Budget State Schema
   * Validates budget state with own and aggregate usage
   */
  const BudgetStateSchema = z.object({
    own: UsageStatsSchema,
    aggregate: UsageStatsSchema,
  });

  const AgentFrameSnapshotSchema: z.ZodType<any> = z.lazy(() =>
    z.object({
      /** Call ID for this frame */
      callId: z.string(),
      /** Agent configuration ID */
      agentId: z.string(),
      /** State recovery data (memory) */
      memory: z.record(z.unknown()),
      /** Execution journal (for replay interception) */
      journal: z.object({
        /** LLM call records */
        prompt: z.record(JournalEntrySchema).optional(),
        /** Tool call records */
        tool: z.record(JournalEntrySchema).optional(),
      }),
      /**
       * Children execution history tree
       * Recursive structure: children can contain more frames
       */
      children: z.record(AgentFrameSnapshotSchema).optional(),
      /** Execution status */
      state: z.object({
        /** Status: running, completed, or failed */
        status: z.enum(["running", "completed", "failed"]),
        /** Return value if completed */
        output: z.unknown().optional(),
        /** Error information if failed */
        error: z.unknown().optional(),
      }),
      /** Budget state with own and aggregate usage */
      budgetState: BudgetStateSchema,
    }),
  );

  /**
   * Agent Snapshot Schema
   *
   * Validates the top-level snapshot structure.
   * This schema ensures that:
   * 1. Root frame exists and has correct structure
   * 2. Required fields (processId, timestamp) are present
   * 3. Data structure matches what restore logic expects
   */
  const AgentSnapshotSchema = z.object({
    /** Process identifier */
    processId: z.string(),
    /** Timestamp when snapshot was created */
    timestamp: z.number(),
    /** Root frame snapshot (contains all children in children field) */
    root: AgentFrameSnapshotSchema,
    /** Provenance information for tracing */
    provenance: z.object({
      traceId: z.string(),
      /** Span ID (may be imprecise when using ctx.spanId directly) */
      spanId: z.string().optional(),
      /** Recovery time anchor: 'before' or 'after' */
      anchor: z.enum(["before", "after"]).optional(),
      /** Source of snapshot: 'dump' or 'restore' */
      source: z.enum(["dump", "restore"]).optional(),
    }),
    /** Snapshot format version: only the current format restores; mismatch fails fast here. */
    version: z.literal(SNAPSHOT_VERSION),
    /**
     * User-defined or Environment-defined tags.
     * Allows extensibility without changing the interface.
     * e.g. { environment: 'prod', description: 'Snapshot before payment', userId: 'u123' }
     */
    metadata: z.record(z.unknown()).optional(),
  });

  return AgentSnapshotSchema;
}
