/**
 * Trace Repository Interface
 *
 * Provides abstraction for trace event storage and querying.
 * Supports different backends: SQLite, ClickHouse, PostgreSQL, etc.
 */

import type { TraceEvent } from "@rejelly/core";

/**
 * Event filter for querying trace events
 */
export interface EventFilter {
  /** Filter by trace ID */
  traceId?: string;
  /** Filter by span ID */
  spanId?: string;
  /** Filter by parent span ID */
  parentSpanId?: string;
  /** Filter by event type(s) */
  types?: string[];
  /** Filter by agent ID */
  agentId?: string;
  /** Filter by timestamp range */
  startTime?: number;
  endTime?: number;
  /** Limit number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Sort order: 'asc' or 'desc' (default: 'asc') */
  order?: "asc" | "desc";
}

/**
 * Trace Repository Interface
 *
 * Provides methods for storing and querying trace events.
 */
export interface TraceRepository {
  /**
   * Batch insert events idempotently (ClickHouse requires batch, SQLite also recommends
   * batch for performance). Returns the subset of events that were newly stored;
   * duplicate deliveries are dropped and excluded from the result.
   */
  insertEvents(events: TraceEvent[]): Promise<TraceEvent[]>;

  /**
   * Query events with filter
   */
  queryEvents(filter: EventFilter): Promise<TraceEvent[]>;

  /**
   * Count events of a trace without materializing payloads
   */
  countEvents(traceId: string): Promise<number>;
}

// Export trace summary repository
export { SqliteTraceSummaryRepo, type TraceSummaryFilter } from "./SqliteTraceSummaryRepo";

import { SqliteTraceRepo } from "./SqliteTraceRepo";
import { SqliteTraceSummaryRepo } from "./SqliteTraceSummaryRepo";

/**
 * Repository composition root.
 *
 * Single shared instances wired over the SQLite backend. Services depend on
 * these; they never construct repositories themselves. This lives in the
 * repository layer (not under db/) so the db/ module stays pure persistence
 * infra and nothing in db/ has to point "up" at repositories.
 */
export const traceRepo = new SqliteTraceRepo();
export const traceSummaryRepo = new SqliteTraceSummaryRepo();
