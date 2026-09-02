/**
 * SQLite Trace Summary Repository Implementation
 *
 * Stores trace summaries with progressive hydration strategy.
 * Updates summary information incrementally as events arrive.
 */

import type {
  AgentEndEvent,
  AgentStartEvent,
  BudgetUpdateEvent,
  CustomSpanStartEvent,
  RunWithEndEvent,
  RunWithStartEvent,
  ToolsExecuteEndEvent,
  TraceEvent,
} from "@rejelly/core";
import type {
  TraceDetail,
  TraceEndReason,
  TraceEntryType,
  TraceStatus,
  TraceSummary,
} from "@rejelly/devtool-contracts";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  like,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type {
  BuiltinFilterKey,
  TraceFilterNode,
  TraceFilterValue,
} from "../capabilities/trace-filter/ast";
import type {
  TraceFilterAttrCatalogEntry,
  TraceFilterCostCatalogEntry,
  TraceFilterModelCatalogEntry,
  TraceFilterToolExecutionCatalogEntry,
} from "../capabilities/trace-filter/catalog";
import { createTraceFilterCompiler } from "../capabilities/trace-filter/compiler";
import { db, schema } from "../db/drizzle";
import type { TraceSummaryRow } from "../db/schema";
import {
  collectToolExecutionSummary,
  mergeToolExecutionSummary,
  parseToolExecutionSummaryJson,
} from "../utils/tool-execution-summary";
import { TraceMutexCache } from "./TraceMutexCache";
import {
  deriveEndReason,
  serializeErrorFull,
  serializeOutputFull,
  truncateErrorMessage,
  truncateInputPreview,
  truncateOutputPreview,
} from "./trace-data-mapper";

function isAttrPrimitive(value: unknown): value is TraceFilterValue {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/** Canonical storage encoding for a primitive attribute value (see trace_attrs columns). */
function encodeAttrValue(value: TraceFilterValue): {
  valueType: string;
  valueText: string | null;
  valueNum: number | null;
} {
  if (value === null) return { valueType: "null", valueText: null, valueNum: null };
  if (typeof value === "boolean")
    return { valueType: "boolean", valueText: String(value), valueNum: null };
  if (typeof value === "number")
    return { valueType: "number", valueText: String(value), valueNum: value };
  return { valueType: "string", valueText: value, valueNum: null };
}

/** Columns addressable by builtin filters; whitelist mirrors BUILTIN_FILTER_KEYS. */
const BUILTIN_FILTER_COLUMNS: Record<BuiltinFilterKey, SQLiteColumn> = {
  status: schema.traceSummaries.status,
  entryType: schema.traceSummaries.entryType,
  name: schema.traceSummaries.name,
  inputPreview: schema.traceSummaries.inputPreview,
  outputPreview: schema.traceSummaries.outputPreview,
  endReason: schema.traceSummaries.endReason,
  errorMessage: schema.traceSummaries.errorMessage,
  isStarred: schema.traceSummaries.isStarred,
  duration: schema.traceSummaries.duration,
  totalTokens: schema.traceSummaries.totalTokens,
  llmCallCount: schema.traceSummaries.llmCallCount,
  toolCallCount: schema.traceSummaries.toolCallCount,
  generationCount: schema.traceSummaries.generationCount,
};

/** EXISTS probe into trace_attrs, optionally constrained on the value columns. */
function rootAttrExists(key: string, valueCondition?: SQL): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(schema.traceAttrs)
      .where(
        and(
          eq(schema.traceAttrs.traceId, schema.traceSummaries.traceId),
          eq(schema.traceAttrs.key, key),
          ...(valueCondition ? [valueCondition] : []),
        ),
      ),
  );
}

const compileTraceFilterNode = createTraceFilterCompiler({
  builtinColumns: BUILTIN_FILTER_COLUMNS,
  rootAttrs: {
    valueType: schema.traceAttrs.valueType,
    valueText: schema.traceAttrs.valueText,
    valueNum: schema.traceAttrs.valueNum,
  },
  rootAttrExists,
  modelUsageJson: schema.traceSummaries.llmUsage,
  costJson: schema.traceSummaries.costs,
  toolExecutionsJson: schema.traceSummaries.toolExecutions,
});

/**
 * Trace summary filter for querying
 */
export interface TraceSummaryFilter {
  /** Filter by status */
  status?: TraceStatus[];
  /** Filter by entry type */
  entryType?: TraceEntryType[];
  /** Filter by name (partial match) */
  name?: string;
  /** Filter by starred */
  isStarred?: boolean;
  /** Filter by timestamp range */
  startTime?: number;
  endTime?: number;
  /** Filter AST conditions compiled to SQL (AND semantics across array items) */
  filterAst?: TraceFilterNode[];
  /** Limit number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Keyset cursor for timestamp + traceId pagination */
  cursor?: {
    timestamp: number;
    traceId: string;
  };
  /** Sort order: 'asc' or 'desc' (default: 'desc') */
  order?: "asc" | "desc";
}

/**
 * SQLite Trace Summary Repository
 *
 * Implements root-event-based update strategy:
 * 1. Identity: Only root events (no parentSpanId or runWith:start) can define trace name, entryType, and input
 * 2. Metrics: All events (including child events) contribute tokens, costs (JSON), and generation count
 * 3. Status: Only root event's end determines the final trace status
 *
 * Uses a per-traceId mutex to serialize read-modify-write of JSON columns (costs, llmUsage, toolUsage)
 * and avoid lost updates when multiple budget:update events are processed concurrently.
 * Mutex cache is FIFO-bounded (max 1000 entries) to avoid memory leak on long runs or batch evals.
 */
export class SqliteTraceSummaryRepo {
  private extractDisplayName(event: TraceEvent): string | null {
    const attrs = event.trace.attributes;
    if (!attrs || typeof attrs !== "object") {
      return null;
    }
    const value = attrs["devtool.display_name"];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  private readonly summaryMutexCache = new TraceMutexCache();

  /**
   * Map database row to TraceSummary entity
   * Centralizes the mapping logic to avoid duplication
   */
  private mapRowToSummary(row: TraceSummaryRow): TraceSummary {
    return {
      traceId: row.traceId,
      name: row.name,
      nameSource: row.nameSource as TraceSummary["nameSource"],
      entryType: (row.entryType as TraceEntryType) || "unknown",
      entrySpanId: row.entrySpanId,
      inputPreview: row.inputPreview,
      outputPreview: row.outputPreview,
      status: row.status as TraceStatus,
      endReason: (row.endReason as TraceEndReason) || null,
      errorMessage: row.errorMessage,
      timestamp: row.timestamp,
      duration: row.duration,
      totalTokens: row.totalTokens,
      costs: row.costs,
      generationCount: row.generationCount,
      llmCallCount: row.llmCallCount,
      toolCallCount: row.toolCallCount,
      toolExecutions: row.toolExecutions,
      toolUsage: row.toolUsage,
      llmUsage: row.llmUsage,
      isStarred: row.isStarred,
      tags: row.tags,
    };
  }

  /**
   * Map database row to TraceDetail entity
   */
  private mapRowToSummaryDetail(row: TraceSummaryRow): TraceDetail {
    return {
      ...this.mapRowToSummary(row),
      outputFull: row.outputFull,
      errorFull: row.errorFull,
    };
  }

  /**
   * Materialize primitive root attributes into trace_attrs (upsert per key).
   * Called on root scope start/end so later events can override earlier keys,
   * mirroring the merge semantics of getEntryAttributes.
   */
  private async upsertRootAttrs(event: TraceEvent): Promise<void> {
    const attrs = event.trace.attributes;
    if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) {
      return;
    }

    for (const [key, value] of Object.entries(attrs)) {
      if (!isAttrPrimitive(value)) continue;
      const encoded = encodeAttrValue(value);
      await db
        .insert(schema.traceAttrs)
        .values({ traceId: event.trace.traceId, key, ...encoded })
        .onConflictDoUpdate({
          target: [schema.traceAttrs.traceId, schema.traceAttrs.key],
          set: encoded,
        });
    }
  }

  /**
   * Unified scope start event handler
   * Handles runWith:start, agent:start, custom:span:start
   */
  private async handleScopeStart(event: TraceEvent, type: TraceEntryType): Promise<void> {
    const traceId = event.trace.traceId;

    // Key logic: Determine if this is a root event
    // runWith:start is always root
    // If parentSpanId is empty or undefined, it's also root
    const isRoot =
      event.type === "runWith:start" ||
      !event.trace.parentSpanId ||
      event.trace.parentSpanId === "";
    // Extract input preview based on event type
    let inputPreview: string | null = null;
    if (event.type === "runWith:start") {
      inputPreview = truncateInputPreview((event as RunWithStartEvent).props);
    } else if (event.type === "agent:start") {
      inputPreview = truncateInputPreview((event as AgentStartEvent).props);
    } else if (event.type === "custom:span:start") {
      inputPreview = truncateInputPreview((event as CustomSpanStartEvent).trace.attributes);
    }

    // Determine name based on event type
    const displayName = isRoot ? this.extractDisplayName(event) : null;
    let name = displayName ?? "Trace";
    if (displayName) {
      name = displayName;
    } else if (event.type === "runWith:start") {
      name = "Running Script...";
    } else if (event.type === "agent:start") {
      name = (event as AgentStartEvent).agentId || "Unknown Agent";
    } else if (event.type === "custom:span:start") {
      name = (event as CustomSpanStartEvent).name;
    }

    // Execute upsert using Drizzle's native ON CONFLICT
    // This is atomic and eliminates race conditions
    await db
      .insert(schema.traceSummaries)
      .values({
        traceId,
        name,
        nameSource: "trace",
        entryType: type,
        entrySpanId: event.trace.spanId,
        inputPreview,
        status: "running",
        timestamp: event.timestamp,
        generationCount: 0,
      })
      .onConflictDoUpdate({
        target: schema.traceSummaries.traceId,
        set: isRoot
          ? {
              // Root event: update name, entryType, inputPreview, and timestamp
              name: sql`CASE WHEN ${schema.traceSummaries.nameSource} = 'user' THEN ${schema.traceSummaries.name} ELSE ${name} END`,
              entryType: type,
              entrySpanId: event.trace.spanId,
              inputPreview: inputPreview || sql`${schema.traceSummaries.inputPreview}`,
              timestamp: event.timestamp,
            }
          : {
              // Non-root event: preserve existing values
              // Keep existing name, entryType, inputPreview, and timestamp unchanged
              // This is a no-op update to satisfy Drizzle's API requirement
              traceId: sql`${schema.traceSummaries.traceId}`,
            },
      });

    if (isRoot) {
      await this.upsertRootAttrs(event);
    }
  }

  /**
   * Extract model name from event
   * Uses provider field if available, otherwise falls back to adapterId parsing
   */
  /**
   * Handle various metrics updates (generation count only; budget from budget:update)
   * All events contribute to trace metrics regardless of hierarchy
   */
  private async handleMetrics(event: TraceEvent): Promise<void> {
    const traceId = event.trace.traceId;
    let genCount = 0;

    if (event.type === "generation:start") {
      genCount = 1;
    }

    // Only execute SQL if there's actual data to update
    if (genCount > 0) {
      // Ensure record exists (prevent case where only metric event arrives)
      await db
        .insert(schema.traceSummaries)
        .values({
          traceId,
          name: "Initializing...",
          entryType: "unknown",
          status: "running",
          timestamp: event.timestamp,
          generationCount: 0,
          llmCallCount: 0,
          totalTokens: 0,
        })
        .onConflictDoNothing();

      await db
        .update(schema.traceSummaries)
        .set({
          generationCount: sql`${schema.traceSummaries.generationCount} + ${genCount}`,
        })
        .where(eq(schema.traceSummaries.traceId, traceId));
    }
  }

  /** Merge billing-unit deltas into a mutable map (integer amounts). */
  private mergeCostRecord(target: Record<string, number>, delta: Record<string, number>): void {
    for (const [k, v] of Object.entries(delta)) {
      target[k] = (target[k] ?? 0) + v;
    }
  }

  private parseCostRecordJson(raw: string | null | undefined): Record<string, number> {
    if (!raw?.trim()) return {};
    try {
      const o = JSON.parse(raw) as Record<string, number>;
      return typeof o === "object" && o !== null && !Array.isArray(o) ? o : {};
    } catch {
      return {};
    }
  }

  /**
   * Handle budget:update events for tokens, costs (JSON), llmCallCount, llmUsage, toolUsage.
   * toolUsage is aggregated by (name, unit), including model-token attribution for LLM-backed tools.
   */
  private async handleBudgetUpdate(event: BudgetUpdateEvent): Promise<void> {
    const traceId = event.trace.traceId;
    const delta = event.delta;
    const tokens = delta.totalTokens ?? 0;
    const hasCostsDelta = !!(delta.costs && Object.keys(delta.costs).length > 0);
    const hasModelItems = delta.items?.some((i) => i.type === "model") ?? false;
    const hasToolItems = delta.items?.some((i) => i.type === "tool") ?? false;
    const llmCallCount = hasModelItems ? (delta.callCount ?? 0) : 0;

    type LlmUsageEntry = {
      count: number;
      prompt_tokens: number;
      completion_tokens: number;
      details?: Record<string, number>;
      costs: Record<string, number>;
    };
    type ToolModelUsageEntry = {
      provider?: string;
      model: string;
      count: number;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      details?: Record<string, number>;
    };
    /** Per (name, unit): tool billing plus model-token attribution. */
    type ToolUsageUnitEntry = {
      callCount: number;
      quantity: number;
      costs: Record<string, number>;
      modelUsages?: Record<string, ToolModelUsageEntry>;
    };
    type ToolUsageUpdate = Record<string, Record<string, ToolUsageUnitEntry>>;

    let llmUsageUpdate: Record<string, LlmUsageEntry> | null = null;
    if (delta.items?.length && hasModelItems) {
      llmUsageUpdate = {};
      for (const item of delta.items) {
        if (item.type !== "model") continue;
        const modelName = item.provider ? `${item.provider}/${item.name}` : item.name;
        const t = item.tokens;
        const details = t.details ? { ...t.details } : undefined;
        llmUsageUpdate[modelName] = {
          count: 1,
          prompt_tokens: t.prompt ?? 0,
          completion_tokens: t.completion ?? 0,
          ...(details && { details }),
          costs: { ...(item.costs ?? {}) },
        };
      }
    }

    let toolUsageUpdate: ToolUsageUpdate | null = null;
    if (delta.items?.length && hasToolItems) {
      toolUsageUpdate = {};
      for (const item of delta.items) {
        if (item.type !== "tool") continue;
        const name = item.name;
        const unit = item.unit ?? "";
        const q = item.quantity ?? 1;
        if (!toolUsageUpdate[name]) toolUsageUpdate[name] = {};
        if (!toolUsageUpdate[name][unit]) {
          toolUsageUpdate[name][unit] = { callCount: 0, quantity: 0, costs: {} };
        }
        toolUsageUpdate[name][unit].callCount += 1;
        toolUsageUpdate[name][unit].quantity += q;
        this.mergeCostRecord(toolUsageUpdate[name][unit].costs, item.costs ?? {});
        for (const usage of item.modelUsages ?? []) {
          const modelName = usage.provider ? `${usage.provider}/${usage.model}` : usage.model;
          const bucket = toolUsageUpdate[name][unit];
          bucket.modelUsages ??= {};
          const existing = bucket.modelUsages[modelName];
          if (existing) {
            existing.count += 1;
            existing.prompt_tokens += usage.tokens.prompt ?? 0;
            existing.completion_tokens += usage.tokens.completion ?? 0;
            existing.total_tokens += usage.tokens.total ?? 0;
            if (usage.tokens.details) {
              existing.details ??= {};
              this.mergeCostRecord(existing.details, usage.tokens.details);
            }
          } else {
            bucket.modelUsages[modelName] = {
              ...(usage.provider ? { provider: usage.provider } : {}),
              model: usage.model,
              count: 1,
              prompt_tokens: usage.tokens.prompt ?? 0,
              completion_tokens: usage.tokens.completion ?? 0,
              total_tokens: usage.tokens.total ?? 0,
              ...(usage.tokens.details ? { details: { ...usage.tokens.details } } : {}),
            };
          }
        }
      }
    }

    const nothingToApply =
      tokens === 0 && !hasCostsDelta && llmCallCount === 0 && !llmUsageUpdate && !toolUsageUpdate;
    if (nothingToApply) {
      return;
    }

    await db
      .insert(schema.traceSummaries)
      .values({
        traceId,
        name: "Initializing...",
        entryType: "unknown",
        status: "running",
        timestamp: event.timestamp,
        generationCount: 0,
        llmCallCount: 0,
        totalTokens: 0,
      })
      .onConflictDoNothing();

    const needExisting = !!(llmUsageUpdate || toolUsageUpdate || hasCostsDelta);
    let existingLlmUsage: Record<string, LlmUsageEntry> = {};
    let existingToolUsage: ToolUsageUpdate = {};
    let mergedTraceCosts: Record<string, number> | null = null;

    if (needExisting) {
      const existingRow = await db
        .select({
          costs: schema.traceSummaries.costs,
          llmUsage: schema.traceSummaries.llmUsage,
          toolUsage: schema.traceSummaries.toolUsage,
        })
        .from(schema.traceSummaries)
        .where(eq(schema.traceSummaries.traceId, traceId))
        .limit(1);

      if (existingRow[0]) {
        if (hasCostsDelta) {
          mergedTraceCosts = this.parseCostRecordJson(existingRow[0].costs);
          this.mergeCostRecord(mergedTraceCosts, delta.costs!);
        }
        if (llmUsageUpdate && existingRow[0].llmUsage) {
          try {
            existingLlmUsage = JSON.parse(existingRow[0].llmUsage) as Record<string, LlmUsageEntry>;
          } catch {
            existingLlmUsage = {};
          }
        }
        if (toolUsageUpdate && existingRow[0].toolUsage) {
          try {
            existingToolUsage = JSON.parse(existingRow[0].toolUsage) as ToolUsageUpdate;
          } catch {
            existingToolUsage = {};
          }
        }
      } else if (hasCostsDelta) {
        mergedTraceCosts = { ...delta.costs! };
      }
    }

    const mergedLlm: Record<string, LlmUsageEntry> = { ...existingLlmUsage };
    if (llmUsageUpdate) {
      for (const [modelName, usage] of Object.entries(llmUsageUpdate)) {
        if (mergedLlm[modelName]) {
          const prev = mergedLlm[modelName];
          const nextCosts = { ...(prev.costs ?? {}) };
          const nextDetails = { ...(prev.details ?? {}) };
          this.mergeCostRecord(nextCosts, usage.costs);
          if (usage.details) {
            this.mergeCostRecord(nextDetails, usage.details);
          }
          mergedLlm[modelName] = {
            count: prev.count + usage.count,
            prompt_tokens: prev.prompt_tokens + usage.prompt_tokens,
            completion_tokens: prev.completion_tokens + usage.completion_tokens,
            ...(Object.keys(nextDetails).length > 0 && { details: nextDetails }),
            costs: nextCosts,
          };
        } else {
          mergedLlm[modelName] = usage;
        }
      }
    }

    const mergedTool: ToolUsageUpdate = JSON.parse(JSON.stringify(existingToolUsage));
    if (toolUsageUpdate) {
      for (const [name, byUnit] of Object.entries(toolUsageUpdate)) {
        if (!mergedTool[name]) mergedTool[name] = {};
        for (const [unit, entry] of Object.entries(byUnit)) {
          if (!mergedTool[name][unit]) {
            mergedTool[name][unit] = { callCount: 0, quantity: 0, costs: {} };
          }
          const bucket = mergedTool[name][unit];
          if (!bucket.costs) bucket.costs = {};
          bucket.callCount = (bucket.callCount ?? 0) + entry.callCount;
          bucket.quantity = (bucket.quantity ?? 0) + entry.quantity;
          this.mergeCostRecord(bucket.costs, entry.costs);
          if (entry.modelUsages) {
            bucket.modelUsages ??= {};
            for (const [modelName, usage] of Object.entries(entry.modelUsages)) {
              const existing = bucket.modelUsages[modelName];
              if (existing) {
                existing.count = (existing.count ?? 0) + usage.count;
                existing.prompt_tokens = (existing.prompt_tokens ?? 0) + usage.prompt_tokens;
                existing.completion_tokens =
                  (existing.completion_tokens ?? 0) + usage.completion_tokens;
                existing.total_tokens = (existing.total_tokens ?? 0) + usage.total_tokens;
                if (usage.details) {
                  existing.details ??= {};
                  this.mergeCostRecord(existing.details, usage.details);
                }
              } else {
                bucket.modelUsages[modelName] = usage;
              }
            }
          }
        }
      }
    }

    await db
      .update(schema.traceSummaries)
      .set({
        totalTokens: sql`COALESCE(${schema.traceSummaries.totalTokens}, 0) + ${tokens}`,
        ...(mergedTraceCosts !== null && { costs: JSON.stringify(mergedTraceCosts) }),
        llmCallCount: sql`${schema.traceSummaries.llmCallCount} + ${llmCallCount}`,
        ...(llmUsageUpdate && { llmUsage: JSON.stringify(mergedLlm) }),
        ...(toolUsageUpdate && { toolUsage: JSON.stringify(mergedTool) }),
      })
      .where(eq(schema.traceSummaries.traceId, traceId));
  }

  /**
   * Handle tool execution metrics: update toolCallCount and per-tool execution facts.
   * Tool budget usage is aggregated in handleBudgetUpdate; this path records execution facts only.
   */
  private async handleToolMetrics(event: TraceEvent): Promise<void> {
    if (event.type !== "tools:execute:end") {
      return;
    }

    const toolEvent = event as ToolsExecuteEndEvent;
    const traceId = event.trace.traceId;
    const toolExecutionDelta = collectToolExecutionSummary(toolEvent);

    await db
      .insert(schema.traceSummaries)
      .values({
        traceId,
        name: "Initializing...",
        entryType: "unknown",
        status: "running",
        timestamp: event.timestamp,
        generationCount: 0,
        llmCallCount: 0,
        totalTokens: 0,
      })
      .onConflictDoNothing();

    const existingRow = await db
      .select({ toolExecutions: schema.traceSummaries.toolExecutions })
      .from(schema.traceSummaries)
      .where(eq(schema.traceSummaries.traceId, traceId))
      .limit(1);
    const mergedToolExecutions = mergeToolExecutionSummary(
      parseToolExecutionSummaryJson(existingRow[0]?.toolExecutions),
      toolExecutionDelta,
    );

    await db
      .update(schema.traceSummaries)
      .set({
        toolCallCount: sql`${schema.traceSummaries.toolCallCount} + ${toolEvent.toolCallsCount || 0}`,
        toolExecutions: JSON.stringify(mergedToolExecutions),
      })
      .where(eq(schema.traceSummaries.traceId, traceId));
  }

  /**
   * Unified scope end event handler
   * Only root event's end determines the final trace status
   */
  private async handleScopeEnd(event: TraceEvent): Promise<void> {
    const traceId = event.trace.traceId;

    // Only root event's end marks the trace as complete
    // runWith:end is always root end
    // If parentSpanId is empty or undefined, it's also root
    const isRootEnd =
      event.type === "runWith:end" || !event.trace.parentSpanId || event.trace.parentSpanId === "";

    if (isRootEnd) {
      let success = false;
      let duration = 0;
      let result: unknown;
      let error: { name?: string; message?: string; stack?: string } | undefined;

      if (event.type === "runWith:end") {
        const runWithEnd = event as RunWithEndEvent;
        success = runWithEnd.success;
        duration = runWithEnd.duration;
        result = runWithEnd.result;
        error = runWithEnd.error;
      } else if (event.type === "agent:end") {
        const agentEnd = event as AgentEndEvent;
        success = agentEnd.success;
        duration = agentEnd.duration;
        result = agentEnd.result;
        error = agentEnd.error;
      }

      const status: TraceStatus = success ? "completed" : "failed";
      const endReason: TraceEndReason = deriveEndReason(success, error);
      const outputPreview = success ? truncateOutputPreview(result) : null;
      const outputFull = success ? serializeOutputFull(result) : null;
      const errorMessage = !success ? truncateErrorMessage(error) : null;
      const errorFull = !success ? serializeErrorFull(error) : null;

      await db
        .update(schema.traceSummaries)
        .set({
          status,
          endReason,
          duration,
          outputPreview,
          outputFull,
          errorMessage,
          errorFull,
        })
        .where(eq(schema.traceSummaries.traceId, traceId));

      await this.upsertRootAttrs(event);
    }
    // Child node ends are ignored for trace summary (only total duration matters)
  }

  /**
   * Process a trace event and update summary accordingly
   *
   * This is the main entry point for event processing.
   * Events are categorized into:
   * 1. Identity events (scope start): Define trace name, entryType, input (only root events)
   * 2. Metrics events: Contribute tokens, costs JSON, generation count (all events)
   * 3. Lifecycle events (scope end): Determine final status (only root events)
   */
  async processEvent(event: TraceEvent): Promise<void> {
    switch (event.type) {
      // 1. Identity events (scope start)
      case "runWith:start":
        await this.handleScopeStart(event, "script");
        break;
      case "agent:start":
        await this.handleScopeStart(event, "agent");
        break;
      case "custom:span:start":
        await this.handleScopeStart(event, "script");
        break;

      // 2. Metrics events
      case "generation:start":
        await this.handleMetrics(event);
        break;
      case "budget:update": {
        const traceId = event.trace.traceId;
        await this.summaryMutexCache
          .getMutex(traceId)
          .runExclusive(() => this.handleBudgetUpdate(event as BudgetUpdateEvent));
        break;
      }

      // 2b. Tool execution events
      case "tools:execute:end":
        await this.handleToolMetrics(event);
        break;

      // 3. Lifecycle events (scope end)
      case "runWith:end":
      case "agent:end":
        await this.handleScopeEnd(event);
        break;

      // Other events are ignored for summary
    }
  }

  /**
   * Batch process events
   */
  async processEvents(events: TraceEvent[]): Promise<void> {
    // Process events sequentially in a transaction
    // Note: Drizzle transactions require passing tx to all operations
    // For simplicity, we process events sequentially without explicit transaction
    // The individual operations are already atomic
    for (const event of events) {
      await this.processEvent(event);
    }
  }

  /**
   * Query trace summaries with filter
   */
  async querySummaries(filter: TraceSummaryFilter = {}): Promise<TraceSummary[]> {
    const conditions = [];

    // Build WHERE conditions
    if (filter.status && filter.status.length > 0) {
      conditions.push(inArray(schema.traceSummaries.status, filter.status));
    }

    if (filter.entryType && filter.entryType.length > 0) {
      conditions.push(inArray(schema.traceSummaries.entryType, filter.entryType));
    }

    if (filter.name) {
      conditions.push(like(schema.traceSummaries.name, `%${filter.name}%`));
    }
    if (filter.isStarred !== undefined) {
      conditions.push(eq(schema.traceSummaries.isStarred, filter.isStarred));
    }

    if (filter.startTime !== undefined) {
      conditions.push(gte(schema.traceSummaries.timestamp, filter.startTime));
    }

    if (filter.endTime !== undefined) {
      conditions.push(lte(schema.traceSummaries.timestamp, filter.endTime));
    }

    if (filter.cursor) {
      const cursorTimestamp = filter.cursor.timestamp;
      const cursorTraceId = filter.cursor.traceId;
      conditions.push(
        filter.order === "asc"
          ? or(
              gt(schema.traceSummaries.timestamp, cursorTimestamp),
              and(
                eq(schema.traceSummaries.timestamp, cursorTimestamp),
                gt(schema.traceSummaries.traceId, cursorTraceId),
              ),
            )!
          : or(
              lt(schema.traceSummaries.timestamp, cursorTimestamp),
              and(
                eq(schema.traceSummaries.timestamp, cursorTimestamp),
                lt(schema.traceSummaries.traceId, cursorTraceId),
              ),
            )!,
      );
    }

    for (const node of filter.filterAst ?? []) {
      conditions.push(compileTraceFilterNode(node));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const order = filter.order || "desc";
    const orderBy =
      order === "asc"
        ? [asc(schema.traceSummaries.timestamp), asc(schema.traceSummaries.traceId)]
        : [desc(schema.traceSummaries.timestamp), desc(schema.traceSummaries.traceId)];
    const limit = filter.limit !== undefined ? filter.limit : 100;

    const rows = await db
      .select()
      .from(schema.traceSummaries)
      .where(whereClause)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(filter.offset);

    return rows.map((row) => this.mapRowToSummary(row));
  }

  /**
   * Catalog of materialized root attribute keys with type, usage count and sample values.
   * Used for filter agent context and (eventually) GUI autocomplete.
   */
  async queryAttrCatalog(limit = 50): Promise<TraceFilterAttrCatalogEntry[]> {
    return await db
      .select({
        key: schema.traceAttrs.key,
        valueType: schema.traceAttrs.valueType,
        count: sql<number>`COUNT(*)`,
        samples: sql<
          string | null
        >`substr(group_concat(DISTINCT ${schema.traceAttrs.valueText}), 1, 160)`,
      })
      .from(schema.traceAttrs)
      .groupBy(schema.traceAttrs.key, schema.traceAttrs.valueType)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(limit);
  }

  /** Catalog of model keys materialized in trace_summaries.llm_usage. */
  async queryModelCatalog(limit = 50): Promise<TraceFilterModelCatalogEntry[]> {
    return await db.all(sql`
      SELECT
        model_usage.key AS model,
        COUNT(*) AS traceCount,
        COALESCE(SUM(CAST(json_extract(model_usage.value, '$.count') AS REAL)), 0) AS callCount
      FROM trace_summaries, json_each(trace_summaries.llm_usage) AS model_usage
      WHERE trace_summaries.llm_usage IS NOT NULL
        AND json_valid(trace_summaries.llm_usage)
      GROUP BY model_usage.key
      ORDER BY COUNT(*) DESC, model_usage.key ASC
      LIMIT ${limit}
    `);
  }

  /** Catalog of cost unit keys materialized in trace_summaries.costs. */
  async queryCostCatalog(limit = 50): Promise<TraceFilterCostCatalogEntry[]> {
    return await db.all(sql`
      SELECT
        cost_usage.key AS unit,
        COUNT(*) AS traceCount,
        COALESCE(SUM(CAST(cost_usage.value AS REAL)), 0) AS totalValue
      FROM trace_summaries, json_each(trace_summaries.costs) AS cost_usage
      WHERE trace_summaries.costs IS NOT NULL
        AND json_valid(trace_summaries.costs)
      GROUP BY cost_usage.key
      ORDER BY COUNT(*) DESC, cost_usage.key ASC
      LIMIT ${limit}
    `);
  }

  /** Catalog of tool execution keys materialized in trace_summaries.tool_executions. */
  async queryToolExecutionCatalog(limit = 50): Promise<TraceFilterToolExecutionCatalogEntry[]> {
    return await db.all(sql`
      SELECT
        tool_execution.key AS tool,
        COUNT(*) AS traceCount,
        COALESCE(SUM(CAST(json_extract(tool_execution.value, '$.callCount') AS REAL)), 0) AS callCount,
        COALESCE(SUM(CAST(json_extract(tool_execution.value, '$.successCount') AS REAL)), 0) AS successCount,
        COALESCE(SUM(CAST(json_extract(tool_execution.value, '$.failureCount') AS REAL)), 0) AS failureCount,
        COALESCE(SUM(CAST(json_extract(tool_execution.value, '$.totalOutputChars') AS REAL)), 0) AS totalOutputChars
      FROM trace_summaries, json_each(trace_summaries.tool_executions) AS tool_execution
      WHERE trace_summaries.tool_executions IS NOT NULL
        AND json_valid(trace_summaries.tool_executions)
      GROUP BY tool_execution.key
      ORDER BY callCount DESC, tool_execution.key ASC
      LIMIT ${limit}
    `);
  }

  /**
   * Get a single trace summary by trace ID
   */
  async getSummary(traceId: string): Promise<TraceSummary | null> {
    const rows = await db
      .select()
      .from(schema.traceSummaries)
      .where(eq(schema.traceSummaries.traceId, traceId))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return this.mapRowToSummary(rows[0]);
  }

  /**
   * Find trace IDs starting with the given prefix, newest first
   */
  async findTraceIdsByPrefix(prefix: string, limit: number): Promise<string[]> {
    const escaped = prefix.replace(/[\\%_]/g, (char) => `\\${char}`);
    const rows = await db
      .select({ traceId: schema.traceSummaries.traceId })
      .from(schema.traceSummaries)
      .where(sql`${schema.traceSummaries.traceId} LIKE ${`${escaped}%`} ESCAPE '\\'`)
      .orderBy(desc(schema.traceSummaries.timestamp))
      .limit(limit);

    return rows.map((row) => row.traceId);
  }

  /**
   * Get trace summary detail with full output and error data
   *
   * @param traceId - Trace ID to query
   * @returns Trace summary detail with full data, or null if not found
   */
  async getSummaryDetail(traceId: string): Promise<TraceDetail | null> {
    const rows = await db
      .select()
      .from(schema.traceSummaries)
      .where(eq(schema.traceSummaries.traceId, traceId))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return this.mapRowToSummaryDetail(rows[0]);
  }

  /**
   * Update trace name (user manual rename)
   */
  async updateName(traceId: string, name: string): Promise<void> {
    await db
      .update(schema.traceSummaries)
      .set({ name, nameSource: "user" })
      .where(eq(schema.traceSummaries.traceId, traceId));
  }

  /**
   * Toggle starred status
   */
  async toggleStarred(traceId: string): Promise<void> {
    await db
      .update(schema.traceSummaries)
      .set({ isStarred: sql`NOT ${schema.traceSummaries.isStarred}` })
      .where(eq(schema.traceSummaries.traceId, traceId));
  }

  /**
   * Update tags
   */
  async updateTags(traceId: string, tags: string[] | null): Promise<void> {
    const tagsJson = tags ? JSON.stringify(tags) : null;
    await db
      .update(schema.traceSummaries)
      .set({ tags: tagsJson })
      .where(eq(schema.traceSummaries.traceId, traceId));
  }

  /**
   * Delete trace summary
   */
  async deleteSummary(traceId: string): Promise<void> {
    await db.delete(schema.traceAttrs).where(eq(schema.traceAttrs.traceId, traceId));
    await db.delete(schema.traceSummaries).where(eq(schema.traceSummaries.traceId, traceId));
  }

  /**
   * Close database connection
   * Note: Database connection is shared, so this is a no-op
   */
  close(): void {
    // Database connection is managed by drizzle.ts
  }
}
