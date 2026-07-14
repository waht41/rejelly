/**
 * Trace service - business logic for trace operations
 */

import type { TraceEvent } from "@rejelly/core";
import type {
  ListTracesResponse,
  TraceDetail,
  TraceEntryType,
  TraceStatus,
} from "@rejelly/devtool-contracts";
import type { TraceFilterRequest } from "../capabilities/trace-filter/ast";
import {
  createTraceFilterCatalog,
  type TraceFilterCatalog,
} from "../capabilities/trace-filter/catalog";
import { MAX_TRACE_SIZE } from "../config";
import { traceRepo, traceSummaryRepo } from "../repositories";
import type { TraceSummaryFilter } from "../repositories/SqliteTraceSummaryRepo";

export interface ListTracesOptions {
  pageSize?: number;
  page?: number;
  status?: TraceStatus[];
  entryType?: TraceEntryType[];
  name?: string;
  isStarred?: boolean;
  startTime?: number;
  endTime?: number;
  order?: "asc" | "desc";
}

type TraceSearchCursor = {
  timestamp: number;
  traceId: string;
};

function encodeTraceSearchCursor(cursor: TraceSearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeTraceSearchCursor(cursor: string): TraceSearchCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid trace search cursor");
  }

  if (!isObjectRecord(parsed)) {
    throw new Error("Invalid trace search cursor");
  }

  const timestamp = parsed.timestamp;
  const traceId = parsed.traceId;
  if (
    typeof timestamp !== "number" ||
    !Number.isInteger(timestamp) ||
    timestamp < 0 ||
    typeof traceId !== "string"
  ) {
    throw new Error("Invalid trace search cursor");
  }

  return { timestamp, traceId };
}

export interface UpdateTraceMetadataOptions {
  name?: string;
  isStarred?: boolean;
  tags?: string[] | null;
}

function getEntryEventTypes(entryType: TraceEntryType): string[] {
  switch (entryType) {
    case "agent":
      return ["agent:start", "agent:end"];
    case "script":
      return ["runWith:start", "runWith:end", "custom:span:start", "custom:span:end"];
    default:
      return [
        "runWith:start",
        "runWith:end",
        "agent:start",
        "agent:end",
        "custom:span:start",
        "custom:span:end",
      ];
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getTimeRangeStart(preset: NonNullable<TraceFilterRequest["timeRange"]>["preset"]) {
  const now = Date.now();
  switch (preset) {
    case "1h":
      return now - 60 * 60 * 1000;
    case "24h":
      return now - 24 * 60 * 60 * 1000;
    case "30d":
      return now - 30 * 24 * 60 * 60 * 1000;
    default: //7d
      return now - 7 * 24 * 60 * 60 * 1000;
  }
}

function parseTimeRange(timeRange: TraceFilterRequest["timeRange"]) {
  const preset = timeRange?.preset ?? "7d";
  const from = timeRange?.from ? Date.parse(timeRange.from) : getTimeRangeStart(preset);
  const to = timeRange?.to ? Date.parse(timeRange.to) : undefined;

  return {
    startTime: Number.isFinite(from) ? from : getTimeRangeStart("7d"),
    endTime: to !== undefined && Number.isFinite(to) ? to : undefined,
  };
}

async function getEntryAttributes(
  traceId: string,
  entrySpanId: string | null,
  entryType: TraceEntryType,
): Promise<Record<string, unknown> | null> {
  if (!entrySpanId) {
    return null;
  }

  const events = await traceRepo.queryEvents({
    traceId,
    spanId: entrySpanId,
    types: getEntryEventTypes(entryType),
    order: "asc",
    limit: 10,
  });
  const attributes: Record<string, unknown> = {};

  for (const event of events) {
    if (isObjectRecord(event.trace.attributes)) {
      Object.assign(attributes, event.trace.attributes);
    }
  }

  return Object.keys(attributes).length > 0 ? attributes : null;
}

export class TraceService {
  /**
   * Ingest trace events
   */
  async ingestEvents(events: TraceEvent[]): Promise<{ traceId: string; eventCount: number }> {
    if (events.length === 0) {
      throw new Error("No events to process");
    }

    const traceId = events[0].trace.traceId;

    // Check trace size limit with COUNT(*) — loading existing events here would
    // deserialize the whole trace on every ingest batch, i.e. O(N²) per trace.
    const existingCount = await traceRepo.countEvents(traceId);
    if (existingCount + events.length > MAX_TRACE_SIZE) {
      throw new Error(`Trace exceeds maximum size of ${MAX_TRACE_SIZE} events`);
    }

    // Store events using repository. Re-ingested duplicates are dropped at the
    // primary key and excluded from the returned set.
    const insertedEvents = await traceRepo.insertEvents(events);

    // Aggregate only newly stored events. The summary counters are additive
    // (tokens, tool/llm call counts, costs), so feeding duplicates would
    // double-count; draining from the deduplicated set keeps it idempotent.
    if (insertedEvents.length > 0) {
      await traceSummaryRepo.processEvents(insertedEvents);
    }

    return { traceId, eventCount: insertedEvents.length };
  }

  /**
   * Get trace events by traceId
   */
  async getTraceEvents(traceId: string): Promise<TraceEvent[]> {
    // Full-trace read: the repo's default limit (1000) silently truncates large
    // traces, so cap explicitly at MAX_TRACE_SIZE — ingestion guarantees no
    // trace exceeds it, making this a total read.
    return await traceRepo.queryEvents({ traceId, order: "asc", limit: MAX_TRACE_SIZE });
  }

  /**
   * List trace summaries with pagination and filtering
   */
  async listTraces(options: ListTracesOptions = {}): Promise<ListTracesResponse> {
    const {
      pageSize = 50,
      page = 1,
      status,
      entryType,
      name,
      isStarred,
      startTime,
      endTime,
      order = "desc",
    } = options;

    // Build filter
    const filter: TraceSummaryFilter = {
      status,
      entryType,
      name,
      isStarred,
      startTime,
      endTime,
      order,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    };

    // Query summaries
    const items = await traceSummaryRepo.querySummaries(filter);

    // For total count, we need to query without limit/offset
    // For simplicity, we'll use hasMore based on whether we got a full page
    const hasMore = items.length === pageSize;

    return {
      items,
      page,
      pageSize,
      hasMore,
    };
  }

  async searchTraces(request: TraceFilterRequest): Promise<ListTracesResponse> {
    const limit = Math.min(Math.max(request.limit ?? 50, 1), 200);
    const { startTime, endTime } = parseTimeRange(request.timeRange);
    const cursor = request.cursor ? decodeTraceSearchCursor(request.cursor) : undefined;

    // Filter AST is compiled to SQL inside the repo (attrs resolved against trace_attrs)
    const items = await traceSummaryRepo.querySummaries({
      startTime,
      endTime,
      order: "desc",
      limit: limit + 1,
      cursor,
      filterAst: request.filters ?? [],
    });
    const hasMore = items.length > limit;
    const pageItems = hasMore ? items.slice(0, limit) : items;
    const lastItem = pageItems[pageItems.length - 1];

    return {
      items: pageItems,
      page: 1,
      pageSize: limit,
      hasMore,
      nextCursor:
        hasMore && lastItem
          ? encodeTraceSearchCursor({ timestamp: lastItem.timestamp, traceId: lastItem.traceId })
          : null,
    };
  }

  /** Catalog for filter generation context / autocomplete. */
  async getTraceFilterCatalog(limit = 50): Promise<TraceFilterCatalog> {
    const [attributes, models, costs, toolExecutions] = await Promise.all([
      traceSummaryRepo.queryAttrCatalog(limit),
      traceSummaryRepo.queryModelCatalog(limit),
      traceSummaryRepo.queryCostCatalog(limit),
      traceSummaryRepo.queryToolExecutionCatalog(limit),
    ]);
    return createTraceFilterCatalog({ attributes, models, costs, toolExecutions });
  }

  /**
   * Get trace summary detail by traceId
   */
  async getTraceDetail(traceId: string): Promise<TraceDetail | null> {
    const detail = await traceSummaryRepo.getSummaryDetail(traceId);
    if (!detail) {
      return null;
    }
    return {
      ...detail,
      attributes: await getEntryAttributes(traceId, detail.entrySpanId, detail.entryType),
    };
  }

  /**
   * Check whether a trace with the exact traceId exists
   */
  async hasTrace(traceId: string): Promise<boolean> {
    return (await traceSummaryRepo.getSummary(traceId)) != null;
  }

  /**
   * Find trace ids starting with the given prefix, newest first
   */
  async findTraceIdsByPrefix(prefix: string, limit = 10): Promise<string[]> {
    return await traceSummaryRepo.findTraceIdsByPrefix(prefix, limit);
  }

  /**
   * Delete trace by traceId
   */
  async deleteTrace(traceId: string): Promise<void> {
    // Delete from both repositories
    await traceSummaryRepo.deleteSummary(traceId);
    // Note: We might want to delete events too, but for now we only delete summary
    // If you want to delete events, uncomment:
    // await traceRepo.deleteEvents({ traceId });
  }

  /**
   * Update trace metadata (name, isStarred, tags)
   */
  async updateTraceMetadata(traceId: string, options: UpdateTraceMetadataOptions): Promise<void> {
    if (options.name !== undefined) {
      await traceSummaryRepo.updateName(traceId, options.name);
    }
    if (options.isStarred !== undefined) {
      // Toggle starred if current value doesn't match desired value
      const current = await traceSummaryRepo.getSummary(traceId);
      if (!current) {
        throw new Error(`Trace ${traceId} not found`);
      }
      if (current.isStarred !== options.isStarred) {
        await traceSummaryRepo.toggleStarred(traceId);
      }
    }
    if (options.tags !== undefined) {
      await traceSummaryRepo.updateTags(traceId, options.tags);
    }
  }
}

// Singleton instance
export const traceService = new TraceService();
