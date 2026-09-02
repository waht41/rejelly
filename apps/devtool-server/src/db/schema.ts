/**
 * Drizzle ORM Schema Definitions
 *
 * Defines database tables for trace events and trace summaries
 */

import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Trace events table
 * Stores individual trace events with JSON payload
 */
export const traceEvents = sqliteTable(
  "trace_events",
  {
    id: text("id").primaryKey(),
    spanId: text("span_id").notNull(),
    traceId: text("trace_id").notNull(),
    parentId: text("parent_id"),
    type: text("type").notNull(),
    timestamp: integer("timestamp").notNull(),
    // Exporter-assigned monotonic seq for secondary sort (same-ms / cross-batch stability)
    seq: integer("seq").notNull().default(0),
    agentId: text("agent_id"),
    payload: text("payload").notNull(), // JSON string
  },
  (table) => ({
    traceIdTimestampIdx: index("idx_trace_id_ts").on(table.traceId, table.timestamp),
    traceIdTimestampSeqIdx: index("idx_trace_id_ts_seq").on(
      table.traceId,
      table.timestamp,
      table.seq,
    ),
    timestampIdx: index("idx_ts").on(table.timestamp),
    spanIdIdx: index("idx_span_id").on(table.spanId),
    typeIdx: index("idx_type").on(table.type),
    agentIdIdx: index("idx_agent_id").on(table.agentId),
  }),
);

/**
 * Trace summaries table
 * Stores aggregated trace summary information
 */
export const traceSummaries = sqliteTable(
  "trace_summaries",
  {
    traceId: text("trace_id").primaryKey(),
    name: text("name").notNull(),
    nameSource: text("name_source").notNull().default("trace"),
    entryType: text("entry_type"),
    entrySpanId: text("entry_span_id"),
    inputPreview: text("input_preview"),
    outputPreview: text("output_preview"),
    outputFull: text("output_full"),
    status: text("status").notNull(),
    endReason: text("end_reason"),
    errorMessage: text("error_message"),
    errorFull: text("error_full"),
    timestamp: integer("timestamp").notNull(),
    duration: integer("duration"),
    totalTokens: integer("total_tokens").default(0),
    /** JSON: Record<string, number> aggregated billing units (e.g. micro_usd) */
    costs: text("costs"),
    generationCount: integer("generation_count").default(0),
    llmCallCount: integer("llm_call_count").default(0),
    toolCallCount: integer("tool_call_count").default(0),
    toolExecutions: text("tool_executions"), // JSON: { "name": { callCount, successCount, failureCount, totalOutputChars, cacheCount } }
    toolUsage: text("tool_usage"), // JSON: { name: { unit: { callCount, quantity, costs, modelUsages? } } }
    llmUsage: text("llm_usage"), // JSON: {"model_name": {count, prompt_tokens, completion_tokens, details, costs}}
    isStarred: integer("is_starred", { mode: "boolean" }).default(false),
    tags: text("tags"), // JSON string
  },
  (table) => ({
    timestampIdx: index("idx_ts_time").on(table.timestamp),
    nameIdx: index("idx_ts_name").on(table.name),
    statusIdx: index("idx_ts_status").on(table.status),
    entryTypeIdx: index("idx_ts_entry_type").on(table.entryType),
    starredIdx: index("idx_ts_starred").on(table.isStarred),
  }),
);

/**
 * Trace root attributes table (EAV)
 * Materialized primitive attributes of each trace's entry span, written at ingest.
 * Backs SQL-level filtering/aggregation in trace search; one row per (trace, key).
 */
export const traceAttrs = sqliteTable(
  "trace_attrs",
  {
    traceId: text("trace_id").notNull(),
    key: text("key").notNull(),
    valueType: text("value_type").notNull(), // "string" | "number" | "boolean" | "null"
    valueText: text("value_text"), // canonical string form; NULL when valueType = "null"
    valueNum: real("value_num"), // numeric form for range queries; NULL unless valueType = "number"
  },
  (table) => ({
    pk: primaryKey({ columns: [table.traceId, table.key] }),
    keyTextIdx: index("idx_trace_attrs_key_text").on(table.key, table.valueText),
    keyNumIdx: index("idx_trace_attrs_key_num").on(table.key, table.valueNum),
  }),
);

export type TraceEventRow = typeof traceEvents.$inferSelect;
export type TraceEventInsert = typeof traceEvents.$inferInsert;
export type TraceSummaryRow = typeof traceSummaries.$inferSelect;
export type TraceSummaryInsert = typeof traceSummaries.$inferInsert;
export type TraceAttrRow = typeof traceAttrs.$inferSelect;
export type TraceAttrInsert = typeof traceAttrs.$inferInsert;
