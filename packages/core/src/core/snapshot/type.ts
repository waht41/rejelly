import type { AgentFrameSnapshot } from "../context/snapshot";

/**
 * Journal payload for different call types
 */
export type JournalPayload =
  | {
      type: "prompt";
      output: unknown;
      contentHash: string; // Prompt fingerprint, include messages, prompt, schema, model id, model provider
    }
  | {
      type: "tool";
      input: unknown;
      output: unknown;
      contentHash: string; // Tool fingerprint, do not include middleware
    };
/**
 * Journal query payload for replay (only needs input/contentHash for validation)
 */
export type JournalQueryPayload =
  | {
      type: "prompt";
      contentHash: string;
    }
  | {
      type: "tool";
      input: unknown;
      contentHash: string;
    };

/**
 * Top-level snapshot structure
 */
export interface AgentSnapshot {
  /** Process identifier */
  processId: string;
  /** Timestamp when snapshot was created */
  timestamp: number;
  /** Root frame snapshot (contains all children in children field) */
  root: AgentFrameSnapshot;
  /** Provenance information for tracing */
  provenance: {
    traceId: string;
    /** Span ID (may be imprecise when using ctx.spanId directly) */
    spanId?: string;
    /** Recovery time anchor: 'before' or 'after' */
    anchor?: "before" | "after";
    /** Source of snapshot: 'dump' or 'restore' */
    source?: "dump" | "restore";
  };
  /** Snapshot format version (equality-checked against SNAPSHOT_VERSION on restore) */
  version: number;
  /**
   * User-defined or Environment-defined tags.
   * Allows extensibility without changing the interface.
   * e.g. { environment: 'prod', description: 'Snapshot before payment', userId: 'u123' }
   */
  metadata?: Record<string, unknown>;
}
