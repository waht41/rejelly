/**
 * SQLite Trace Repository Implementation
 *
 * Stores trace events in SQLite database with optimized indexes.
 * Uses Drizzle ORM for type-safe database operations.
 */

import type { TraceEvent } from "@rejelly/core";
import { and, asc, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { db, schema } from "../db/drizzle";
import type { EventFilter, TraceRepository } from "./index";

/**
 * Deterministic row id derived from the event itself, so re-ingesting the same
 * event (HTTP retry, file re-import, reconnect replay) collides on the primary
 * key instead of inserting a duplicate row. Mirrors the UI dedup key in
 * traceCache.ts (`spanId:timestamp:type`), scoped with traceId for the shared
 * table.
 *
 * NOTE: do NOT key off `event.id`. The only events carrying a top-level `id`
 * are model:call:start/end, where `id` is the model **adapter id** (e.g.
 * "deepseek-v4-flash"), not a unique event id. Using it collapses every model
 * call across every trace onto a single primary key, so onConflictDoNothing
 * drops all but the first — which deletes model-call spans and orphans the
 * budget:update events parented to them.
 */
function eventRowId(event: TraceEvent): string {
  return `${event.trace.traceId}:${event.trace.spanId}:${event.timestamp}:${event.type}`;
}

/**
 * SQLite Trace Repository
 *
 * Implements TraceRepository using SQLite with Drizzle ORM.
 * All events are stored in a single table with JSON payload column.
 */
export class SqliteTraceRepo implements TraceRepository {
  /**
   * Schema initialization is handled by Drizzle migrations
   * Indexes are defined in schema.ts
   */

  /**
   * Batch insert events idempotently.
   *
   * Each event gets a deterministic id (see eventRowId), and inserts use
   * ON CONFLICT DO NOTHING so duplicate deliveries are silently dropped at the
   * primary key. Intra-batch duplicates are dropped the same way.
   *
   * @param events - Array of trace events to insert
   * @returns The subset of events that were newly stored (conflicts excluded).
   *   Callers use this to drive idempotent downstream aggregation.
   */
  async insertEvents(events: TraceEvent[]): Promise<TraceEvent[]> {
    if (events.length === 0) return [];

    const insertData = events.map((event) => ({
      id: eventRowId(event),
      spanId: event.trace.spanId,
      traceId: event.trace.traceId,
      parentId: event.trace.parentSpanId || null,
      type: event.type,
      timestamp: event.timestamp,
      seq: (event as TraceEvent & { _seq: number })._seq,
      agentId: event.agentId || null,
      payload: JSON.stringify(event),
    }));

    const inserted = await db
      .insert(schema.traceEvents)
      .values(insertData)
      .onConflictDoNothing()
      .returning({ payload: schema.traceEvents.payload });

    return inserted.map((row) => JSON.parse(row.payload) as TraceEvent);
  }

  /**
   * Query events with filter
   *
   * @param filter - Filter criteria
   * @returns Array of matching trace events
   */
  async queryEvents(filter: EventFilter): Promise<TraceEvent[]> {
    const conditions = [];

    if (filter.traceId) {
      conditions.push(eq(schema.traceEvents.traceId, filter.traceId));
    }

    if (filter.spanId) {
      conditions.push(eq(schema.traceEvents.spanId, filter.spanId));
    }

    if (filter.parentSpanId) {
      conditions.push(eq(schema.traceEvents.parentId, filter.parentSpanId));
    }

    if (filter.types && filter.types.length > 0) {
      conditions.push(inArray(schema.traceEvents.type, filter.types));
    }

    if (filter.agentId) {
      conditions.push(eq(schema.traceEvents.agentId, filter.agentId));
    }

    if (filter.startTime !== undefined) {
      conditions.push(gte(schema.traceEvents.timestamp, filter.startTime));
    }

    if (filter.endTime !== undefined) {
      conditions.push(lte(schema.traceEvents.timestamp, filter.endTime));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const order = filter.order || "asc";
    const orderBys =
      order === "asc"
        ? [asc(schema.traceEvents.timestamp), asc(schema.traceEvents.seq)]
        : [desc(schema.traceEvents.timestamp), desc(schema.traceEvents.seq)];
    const limit = filter.limit !== undefined ? filter.limit : 1000;

    const rows = await db
      .select({ payload: schema.traceEvents.payload })
      .from(schema.traceEvents)
      .where(whereClause)
      .orderBy(...orderBys)
      .limit(limit)
      .offset(filter.offset);

    // Deserialize events from JSON
    return rows.map((row) => JSON.parse(row.payload) as TraceEvent);
  }

  /**
   * Count events of a trace with COUNT(*), avoiding payload deserialization
   */
  async countEvents(traceId: string): Promise<number> {
    const [row] = await db
      .select({ value: count() })
      .from(schema.traceEvents)
      .where(eq(schema.traceEvents.traceId, traceId));
    return row?.value ?? 0;
  }

  /**
   * Get all unique trace IDs
   *
   * @returns Array of unique trace IDs
   */
  async getAllTraceIds(): Promise<string[]> {
    const rows = await db
      .selectDistinct({ traceId: schema.traceEvents.traceId })
      .from(schema.traceEvents)
      .orderBy(asc(schema.traceEvents.traceId));

    return rows.map((row) => row.traceId);
  }

  /**
   * Close database connection
   * Note: Database connection is shared, so this is a no-op
   */
  close(): void {
    // Database connection is managed by drizzle.ts
  }
}
