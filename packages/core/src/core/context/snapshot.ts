import type { BudgetState } from "../domain/budget";
import type { CallId, Hash } from "./type";

/**
 * Journal entry for recording call results
 */
export interface JournalEntry {
  /** Previous return value (undefined if non-serializable) */
  output: unknown;
  /** hash for prompt, tool */
  contentHash: string;
  /** Optional: serialization error marker (tombstone) */
  error?: string;
}

/**
 * Frame snapshot structure
 */
export interface AgentFrameSnapshot {
  /** Call ID for this frame, e.g., "root/agent:setup:0" (stored as key in parent's children) */
  callId: string;
  /** Agent configuration ID, e.g., "search_agent" */
  agentId: string;
  /** State recovery data (for inject to Context) */
  memory: Record<string, unknown>;
  /** Execution journal (for Replay interception) */
  journal: {
    /** LLM call records */
    prompt: Record<Hash, JournalEntry>;
    /** Tool call records */
    tool: Record<Hash, JournalEntry>;
  };
  /**
   * Children execution history tree
   *
   * Stores all child Agent execution records.
   * Both completed and running agents are stored here.
   *
   * This is a recursive structure:
   * When replaying, parent Agent encounters await ChildAgent(),
   * it will retrieve children[callId] and pass this Frame to child Agent for recursive replay.
   */
  children: Record<CallId, AgentFrameSnapshot>;
  /** Execution status (current frame state) */
  state: {
    /**
     * - running: Currently executing (or blocked on some await)
     * - completed: Execution finished and returned
     * - failed: Threw an error
     */
    status: "running" | "completed" | "failed";
    /** If status === 'completed', stores the return value */
    output?: unknown;
    /** If status === 'failed', stores the error information */
    error?: unknown;
  };
  /** Budget state with own and aggregate usage */
  budgetState: BudgetState;
}
