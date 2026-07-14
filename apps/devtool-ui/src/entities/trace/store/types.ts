import type { NormalizedTrace } from "src/entities/trace/types";

export interface TraceSummary {
  traceId: string;
  timestamp: number;
  agentId?: string;
  eventCount: number;
  /** User-visible trace name */
  name?: string;
  /** Source of the current trace name */
  nameSource?: "trace" | "user";
  /** Adapter type for the trace connection */
  adapterType?: string;
  /** Starred status */
  isStarred?: boolean;
  /** Tags JSON string (server format) */
  tags?: string | null;
}

export interface TraceState {
  currentTraceId: string | null;
  /** Normalized model (flat nodeMap + waterfall); null when no session. */
  normalizedTrace: NormalizedTrace.Trace | null;
  status: "idle" | "connecting" | "loading" | "streaming" | "error";
  error: Error | null;
  /** Incremented by reload() to force useTraceConnection to reconnect */
  reloadTrigger: number;
}

export interface TraceActions {
  setCurrentTraceId: (id: string | null) => void;
  setNormalizedTraceData: (data: NormalizedTrace.Trace | null) => void;
  setStatus: (status: TraceState["status"]) => void;

  closeTrace: () => void;
  reload: () => void;
}
