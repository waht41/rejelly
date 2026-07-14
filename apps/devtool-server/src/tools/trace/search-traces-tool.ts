import type { ToolDefinition } from "@rejelly/core";
import type { TraceSummary } from "@rejelly/devtool-contracts";
import { z } from "zod";
import type { TraceFilterNode, TraceFilterRequest } from "../../capabilities/trace-filter/ast";
import { traceService } from "../../services/trace.service";
import {
  describeDefaultTrace,
  normalizeTraceToolContext,
  type TraceToolContextInput,
} from "./shared/default-trace-context";
import { formatDuration, truncate } from "./shared/format";

const TRACE_SEARCH_TEXT_KEYS = ["name", "inputPreview", "outputPreview", "errorMessage"] as const;
const DEFAULT_TRACE_LIMIT = 20;

const SearchTracesParameters = z.object({
  timeRange: z
    .object({
      preset: z.enum(["1h", "24h", "7d", "30d"]).optional(),
      from: z.string().optional().describe("Inclusive lower bound timestamp."),
      to: z.string().optional().describe("Exclusive upper bound timestamp."),
    })
    .optional()
    .describe(
      "Trace start time range. Defaults to the existing trace filter behavior: preset 7d when omitted.",
    ),
  statuses: z
    .array(z.enum(["running", "completed", "failed"]))
    .min(1)
    .optional()
    .describe("Trace statuses to match with OR semantics."),
  endReasons: z
    .array(z.enum(["success", "error", "budget_exceeded", "interrupted"]))
    .min(1)
    .optional()
    .describe("Trace end reasons to match with OR semantics."),
  textContains: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Case-insensitive text contained in any trace summary text field: name, inputPreview, outputPreview, or errorMessage.",
    ),
  modelsAny: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe("Model keys where a trace matches if it used any listed model at least once."),
  toolsAny: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe("Tool keys where a trace matches if it executed any listed tool at least once."),
  minDurationMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Only traces whose duration is at least this many milliseconds."),
  minTotalTokens: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Only traces whose total token count is at least this value."),
  minLlmCallCount: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Only traces whose LLM call count is at least this value."),
  minToolCallCount: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Only traces whose tool call count is at least this value."),
  isStarred: z.boolean().optional().describe("Filter starred or unstarred traces."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum traces to return. Defaults to 20."),
  cursor: z
    .string()
    .optional()
    .describe("Pagination cursor returned by a previous search_traces call."),
});

type SearchTracesArgs = z.infer<typeof SearchTracesParameters>;

function anyOf(filters: TraceFilterNode[]): TraceFilterNode | undefined {
  if (filters.length === 0) return undefined;
  if (filters.length === 1) return filters[0];
  return { kind: "or", filters };
}

function addOptionalFilter(filters: TraceFilterNode[], filter: TraceFilterNode | undefined) {
  if (filter) filters.push(filter);
}

function buildTraceFilterRequest(args: SearchTracesArgs): TraceFilterRequest {
  const filters: TraceFilterNode[] = [];

  addOptionalFilter(
    filters,
    anyOf(
      (args.statuses ?? []).map((status) => ({
        kind: "builtin",
        key: "status",
        op: "eq",
        value: status,
      })),
    ),
  );

  addOptionalFilter(
    filters,
    anyOf(
      (args.endReasons ?? []).map((endReason) => ({
        kind: "builtin",
        key: "endReason",
        op: "eq",
        value: endReason,
      })),
    ),
  );

  if (args.textContains) {
    addOptionalFilter(
      filters,
      anyOf(
        TRACE_SEARCH_TEXT_KEYS.map((key) => ({
          kind: "builtin",
          key,
          op: "contains",
          value: args.textContains,
        })),
      ),
    );
  }

  addOptionalFilter(
    filters,
    anyOf(
      (args.modelsAny ?? []).map((model) => ({
        kind: "model_usage",
        model,
        op: "exists",
      })),
    ),
  );

  addOptionalFilter(
    filters,
    anyOf(
      (args.toolsAny ?? []).map((tool) => ({
        kind: "tool_execution",
        tool,
        op: "exists",
      })),
    ),
  );

  if (args.minDurationMs !== undefined) {
    filters.push({ kind: "builtin", key: "duration", op: "gte", value: args.minDurationMs });
  }
  if (args.minTotalTokens !== undefined) {
    filters.push({ kind: "builtin", key: "totalTokens", op: "gte", value: args.minTotalTokens });
  }
  if (args.minLlmCallCount !== undefined) {
    filters.push({
      kind: "builtin",
      key: "llmCallCount",
      op: "gte",
      value: args.minLlmCallCount,
    });
  }
  if (args.minToolCallCount !== undefined) {
    filters.push({
      kind: "builtin",
      key: "toolCallCount",
      op: "gte",
      value: args.minToolCallCount,
    });
  }
  if (args.isStarred !== undefined) {
    filters.push({ kind: "builtin", key: "isStarred", op: "eq", value: args.isStarred });
  }

  return {
    timeRange: args.timeRange,
    filters,
    limit: args.limit ?? DEFAULT_TRACE_LIMIT,
    cursor: args.cursor,
  };
}

function formatTraceLine(trace: TraceSummary, index: number): string[] {
  const title = trace.name || "(unnamed trace)";
  const status = `${trace.status}${trace.endReason ? `/${trace.endReason}` : ""}`;
  const startedAt = new Date(trace.timestamp).toISOString();
  const star = trace.isStarred ? " starred" : "";
  const lines = [
    `${index + 1}. ${trace.traceId} ${status}${star} ${formatDuration(trace.duration)} ${startedAt}`,
    `   name: ${truncate(title, 140)}`,
    `   calls: llm=${trace.llmCallCount}, tool=${trace.toolCallCount}, generations=${trace.generationCount}, tokens=${trace.totalTokens ?? 0}`,
  ];

  if (trace.errorMessage) {
    lines.push(`   error: ${truncate(trace.errorMessage, 220)}`);
  } else if (trace.inputPreview) {
    lines.push(`   input: ${truncate(trace.inputPreview, 180)}`);
  }

  return lines;
}

function formatTraceSearchResult(
  args: SearchTracesArgs,
  request: TraceFilterRequest,
  traces: TraceSummary[],
  hasMore: boolean,
  nextCursor: string | null | undefined,
): string {
  const lines = [
    "Trace Search",
    `- time_range: ${JSON.stringify(request.timeRange ?? { preset: "7d" })}`,
    `- filters: ${JSON.stringify(request.filters)}`,
    `- matched: ${traces.length}${hasMore ? " (more available)" : ""}`,
    `- limit: ${request.limit ?? DEFAULT_TRACE_LIMIT}`,
    ...(args.cursor ? [`- cursor: ${args.cursor}`] : []),
    ...(nextCursor ? [`- next_cursor: ${nextCursor}`] : []),
    "",
  ];

  if (traces.length === 0) {
    lines.push("- no traces matched");
    return lines.join("\n");
  }

  for (const [index, trace] of traces.entries()) {
    lines.push(...formatTraceLine(trace, index));
  }
  lines.push("", "- use get_trace_profile with a traceId to inspect one result");
  if (nextCursor) lines.push("- pass next_cursor as cursor to continue");
  return lines.join("\n");
}

export function createSearchTracesTool(
  contextInput?: TraceToolContextInput,
): ToolDefinition<typeof SearchTracesParameters> {
  const context = normalizeTraceToolContext(contextInput);
  return {
    name: "search_traces",
    description: `Search trace summaries across the trace history using a simplified filter surface. Filters include timeRange, statuses, endReasons, summary text contains, modelsAny/toolsAny existence, minimum duration/tokens/call counts, and starred state. Returns matching trace ids and compact summaries. Use this only to locate older or specific historical traces — not needed for ${describeDefaultTrace(
      context,
    )}, which per-trace tools use when traceId is omitted.`,
    parameters: SearchTracesParameters,
    handler: async (args) => {
      const request = buildTraceFilterRequest(args);
      const result = await traceService.searchTraces(request);
      return formatTraceSearchResult(
        args,
        request,
        result.items,
        result.hasMore,
        result.nextCursor,
      );
    },
  };
}
