/** Identifies one in-flight tool call from observation start until its completed block. */
export interface ToolCallHandle {
  id: string;
  /** Display number assigned in call order so parallel calls stay readable. */
  ordinal: number;
}

export interface ToolObservationStart {
  toolName: string;
  summary: string;
  /** Projected at invocation time so live transcript views can inspect the call before it finishes. */
  args?: string;
}

export type ToolObservationDetail = {
  type: "diff";
  text: string;
  caption?: string;
  captionTitle?: string;
  /** Proposed changes are review material; applied changes reflect successful filesystem writes. */
  phase?: "proposed" | "applied";
  /** Inline is reserved for writes that did not already show a confirmation diff. */
  presentation?: "inline" | "expanded";
};

export interface GrepSearchToolMetrics {
  type: "grep_search";
  matches: number;
  files: number;
  snippets: number;
  emittedLines: number;
  contextLines: number;
  mergedRanges: number;
  omittedMatches: number;
  truncated: boolean;
}

export type ToolObservationMetrics = GrepSearchToolMetrics;

export type ToolExecutionOutcome = "succeeded" | "failed" | "denied" | "aborted" | "timed_out";

export interface ToolExecutionOutcomeRecord {
  outcome: ToolExecutionOutcome;
  exitCode?: number | null;
  failureKind?: string;
}

export interface ToolObservationBlock extends ToolObservationStart {
  /** The handle issued when observation started, when the sink supports live calls. */
  id?: string;
  ordinal?: number;
  args?: string;
  detail?: ToolObservationDetail;
  metrics?: ToolObservationMetrics;
  preview: string;
  fullResult: string;
  /** Transport/handler completion only; business success is represented by `outcome`. */
  ok: boolean;
  outcome?: ToolExecutionOutcome;
  exitCode?: number | null;
  failureKind?: string;
}
