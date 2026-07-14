/**
 * Filter Agent
 *
 * Compiles a natural-language description into a trace filter AST
 * (TraceFilterRequest.filters). One-shot translation: the agent is a
 * compiler, not a runtime — the produced AST is what gets saved/replayed.
 *
 * Conversation history (promptChat delta) is round-tripped through the
 * client so the user can refine the result ("再加上失败的") in follow-ups.
 */

import {
  createAgent,
  equipSystem,
  equipTraceAttr,
  expectValidator,
  type Message,
  promptChat,
} from "@rejelly/core";
import { z } from "zod";
import {
  BUILTIN_FILTER_KEYS,
  TOOL_EXECUTION_FILTER_FIELDS,
  type TraceFilterNode,
  type TraceFilterRequest,
} from "../capabilities/trace-filter/ast";
import {
  EMPTY_TRACE_FILTER_CATALOG,
  type TraceFilterAttrCatalogEntry,
  type TraceFilterCatalog,
  type TraceFilterCostCatalogEntry,
  type TraceFilterModelCatalogEntry,
  type TraceFilterToolExecutionCatalogEntry,
} from "../capabilities/trace-filter/catalog";
import { validateFilterNode } from "../capabilities/trace-filter/validation";
import { type DevtoolModel, enableDevtoolReviewOnce } from "./shared";

export interface CurrentTraceAttrEntry {
  key: string;
  value: string | number | boolean | null;
}

export interface CurrentTraceContext {
  traceId: string;
  attrs: CurrentTraceAttrEntry[];
}

function isLocalDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value);
}

/**
 * Response schema. `filters` is intentionally loose (array of objects):
 * zodToJsonSchema runs with $refStrategy "none", so a recursive AST schema
 * cannot be expressed here. The grammar lives in the system prompt and the
 * strict check happens in expectValidator (invalid output -> retry).
 */
const FilterAgentResponseSchema = z.object({
  status: z
    .enum(["ok", "clarification", "out_of_scope", "unsupported_field"])
    .describe(
      [
        "ok: filters generated",
        "clarification: need more info",
        "out_of_scope: not a trace search",
        "unsupported_field: trace search request targets data that is not currently queryable",
      ].join("; "),
    ),
  message: z
    .string()
    .optional()
    .describe("Short user-facing note: what the filter does, or the clarification question"),
  time_range: z
    .union([
      z.object({
        type: z.literal("preset"),
        preset: z.enum(["1h", "24h", "7d", "30d"]),
      }),
      z.object({
        type: z.literal("range"),
        from_local: z
          .string()
          .optional()
          .describe("Inclusive lower bound as a browser-local timestamp without timezone"),
        to_local: z
          .string()
          .optional()
          .describe("Exclusive upper bound as a browser-local timestamp without timezone"),
      }),
    ])
    .optional()
    .describe("Time range. Use preset for quick recent ranges; range for precise local bounds."),
  filters: z
    .array(z.record(z.unknown()))
    .optional()
    .describe("Filter AST nodes (AND semantics across array items); required when status is ok"),
});

type FilterAgentResponseData = z.infer<typeof FilterAgentResponseSchema>;

export type FilterAgentResponse = Omit<FilterAgentResponseData, "filters"> & {
  filters?: TraceFilterNode[];
  delta: Message[];
};

export type FilterAgentTimeRange = NonNullable<FilterAgentResponse["time_range"]>;

function formatAttrCatalog(catalog: TraceFilterAttrCatalogEntry[]): string {
  if (catalog.length === 0) {
    return "(no materialized attributes yet)";
  }
  return catalog
    .map((entry) => {
      const samples = entry.samples ? ` e.g. ${entry.samples}` : "";
      return `- ${entry.key} (${entry.valueType}, ${entry.count} traces)${samples}`;
    })
    .join("\n");
}

function formatModelCatalog(catalog: TraceFilterModelCatalogEntry[]): string {
  if (catalog.length === 0) {
    return "(no materialized models yet)";
  }
  return catalog
    .map((entry) => `- ${entry.model} (${entry.traceCount} traces, ${entry.callCount} calls)`)
    .join("\n");
}

function formatCostCatalog(catalog: TraceFilterCostCatalogEntry[]): string {
  if (catalog.length === 0) {
    return "(no materialized cost units yet)";
  }
  return catalog
    .map((entry) => `- ${entry.unit} (${entry.traceCount} traces, total ${entry.totalValue})`)
    .join("\n");
}

function formatToolExecutionCatalog(catalog: TraceFilterToolExecutionCatalogEntry[]): string {
  if (catalog.length === 0) {
    return "(no materialized tool executions yet)";
  }
  return catalog
    .map(
      (entry) =>
        `- ${entry.tool} (${entry.traceCount} traces, ${entry.callCount} calls, ${entry.successCount} success, ${entry.failureCount} failure, ${entry.totalOutputChars} output chars)`,
    )
    .join("\n");
}

function formatTraceAttrValue(value: CurrentTraceAttrEntry["value"]): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function formatCurrentTraceAttrs(context: CurrentTraceContext | null): string {
  if (!context) {
    return "(no current trace is open in the UI context)";
  }
  if (context.attrs.length === 0) {
    return `current_trace.id = ${context.traceId}\n(no primitive root attributes found on the current trace)`;
  }

  return [
    `current_trace.id = ${context.traceId}`,
    ...context.attrs.map(
      (attr) =>
        `- current_trace.attr.${attr.key} = ${formatTraceAttrValue(
          attr.value,
        )} (AST key: ${attr.key})`,
    ),
  ].join("\n");
}

function formatCurrentFilterSettings(request: TraceFilterRequest | null): string {
  if (!request) {
    return "(no current filter settings were provided by the UI)";
  }

  const timeRange = request.timeRange ?? {};
  const lines = [
    `current_filter.time_preset = ${timeRange.preset ?? "7d"}`,
    `current_filter.time_from = ${timeRange.from ?? "(unset)"}`,
    `current_filter.time_to = ${timeRange.to ?? "(unset)"}`,
    "current_filter.filters =",
    JSON.stringify(request.filters, null, 2),
  ];

  return lines.join("\n");
}

function formatCurrentTime(now: string | null): string {
  if (!now) {
    return "(current browser time was not provided)";
  }
  return `current_time.local = ${now}`;
}

function buildFilterUserMessage({
  prompt,
  catalog,
  currentRequest,
  currentTrace,
  now,
}: {
  prompt: string;
  catalog: TraceFilterCatalog;
  currentRequest: TraceFilterRequest | null;
  currentTrace: CurrentTraceContext | null;
  now: string | null;
}) {
  return `
# Current time
Use this browser-local timestamp as the only clock for relative date/time phrases.
${formatCurrentTime(now)}

# Current UI filter settings
These are the settings currently shown in the filter modal before the user's latest message.
${formatCurrentFilterSettings(currentRequest)}

# Current UI trace root attributes
These are primitive root attributes from the trace currently open in the UI. The stable prompt prefix is "current_trace.attr."; do not include that prefix in the AST key. Use the AST key shown after each value.
${formatCurrentTraceAttrs(currentTrace)}

# Available root attributes
These are from the live catalog; prefer these keys for general searches.
${formatAttrCatalog(catalog.attributes)}

# Available models
These model keys are from the live llm usage catalog. Use these exact keys for model_usage filters.
${formatModelCatalog(catalog.models)}

# Available cost units
These cost unit keys are from the live costs catalog. Use these exact keys for cost filters.
${formatCostCatalog(catalog.costs)}

# Available tool executions
These tool keys are from the live tool execution catalog. Use these exact keys for tool_execution filters.
${formatToolExecutionCatalog(catalog.toolExecutions)}

# Latest user request
${prompt}
  `.trim();
}

export function createFilterAgent(model: DevtoolModel) {
  enableDevtoolReviewOnce();

  return createAgent<
    {
      prompt: string;
      history?: Message[];
      catalog?: TraceFilterCatalog;
      currentTrace?: CurrentTraceContext | null;
      currentRequest?: TraceFilterRequest | null;
      now?: string | null;
    },
    FilterAgentResponse
  >({
    id: "filter_agent",
    model,
    handler: async ({
      prompt,
      history = [],
      catalog = EMPTY_TRACE_FILTER_CATALOG,
      currentTrace = null,
      currentRequest = null,
      now = null,
    }) => {
      equipTraceAttr({
        "devtool.source": "ai_filter",
        "devtool.target_trace_id": currentTrace?.traceId ?? null,
      });

      equipSystem(`
You translate a natural-language trace search request into a structured filter AST. You are a compiler: output the AST, do not chat.

# Scope
This endpoint is a trace-history discovery filter over materialized trace summaries and root trace attributes. It is not a full span-query or observability-backend query engine.
The Available root attributes catalog is queryable through root_attr leaves. If an attribute-like key such as service.name, http.route, or deployment.environment appears in Available root attributes or Current UI trace root attributes, use that exact key as a root_attr filter.
Do not invent filters for span/resource/event/link attributes, service graphs, parent-child span relationships, arbitrary tags, span operation names, or per-span durations/statuses unless that exact data is present as a current trace root attribute, catalog root attribute, builtin field, model_usage key, cost unit, or tool_execution key.
In tracing tools, "tags" usually means key-value metadata on a trace, resource/process, span, event, or link. Only materialized root trace attributes from the catalog/current trace are queryable here. If the user asks for tags, service.name, resource attributes, span attributes, operation/span name, HTTP/DB/RPC semantic-convention fields, or child-span errors and the exact key is not listed in the queryable root-attribute catalog/current trace attrs, return "unsupported_field" instead of compiling a guessed root_attr filter.

# AST grammar
Each node is one of:
- { "kind": "root_attr", "key": <string>, "op": <op>, "value": <string|number|boolean|null> } — condition on a trace root attribute
- { "kind": "root_attr", "key": <string>, "op": "exists" } — attribute presence (no "value" field)
- { "kind": "builtin", "key": <builtin key>, "op": <op>, "value": <string|number|boolean|null> } — condition on a trace summary column
- { "kind": "builtin", "key": <builtin key>, "op": "exists" } — summary column is present/non-null (no "value" field)
- { "kind": "model_usage", "model": <model key>, "op": "exists" } — trace used the model at least once
- { "kind": "model_usage", "model": <model key>, "field": "count", "op": "eq"|"neq"|"gt"|"gte"|"lt"|"lte", "value": <number> } — trace used the model a comparable number of times
- { "kind": "cost", "unit": <cost unit key>, "op": "exists" } — trace has a cost entry for the unit
- { "kind": "cost", "unit": <cost unit key>, "op": "eq"|"neq"|"gt"|"gte"|"lt"|"lte", "value": <number> } — compare the stored numeric cost value for the unit
- { "kind": "tool_execution", "tool": <tool key>, "op": "exists" } — trace executed the tool at least once
- { "kind": "tool_execution", "tool": <tool key>, "field": "callCount"|"successCount"|"failureCount"|"totalOutputChars", "op": "eq"|"neq"|"gt"|"gte"|"lt"|"lte", "value": <number> } — compare an aggregated execution metric for the tool
- { "kind": "and", "filters": [<node>, ...] } / { "kind": "or", "filters": [<node>, ...] }
- { "kind": "not", "filter": <node> }
Ops: eq, neq, gt, gte, lt, lte, contains (string only), exists.
The top-level "filters" array has AND semantics. neq means "attribute exists with a different value"; wrap with "not" for "missing or different".

# Builtin keys (trace summary columns)
${BUILTIN_FILTER_KEYS.join(", ")}
- status values: running | completed | failed (coarse outcome; failed = any non-success end)
- endReason values: success | error | budget_exceeded | interrupted (why the trace ended). endReason refines status: budget_exceeded = cost/token budget hit, interrupted = aborted / Ctrl+C, error = genuine failure. Use status=failed for "failed / not successful"; endReason=budget_exceeded for "budget/cost cut off". Intentional aborts also land as status=failed, so to list only real failures use and(status eq failed, endReason neq interrupted).
- entryType values: agent | script | unknown
- duration is milliseconds; totalTokens / llmCallCount / toolCallCount / generationCount are numbers; isStarred is boolean; name / inputPreview / outputPreview / errorMessage are strings (contains works well)

# Model usage
Model usage is queryable only through model_usage leaves. Use exact model keys from Available models. If the user's model phrase unambiguously maps to one available key, output that exact key; otherwise do not invent, normalize, or shorten model names. If the requested model is absent or ambiguous, return "unsupported_field" rather than compiling a guessed model_usage filter. For "used model X" use op "exists"; for "used model X more than N times" use field "count" with a numeric comparison.

# Cost
Trace-level total cost is queryable only through cost leaves. Use exact unit keys from Available cost units. Cost AST values are always stored-unit numbers; do not output display currency values unless the stored unit is the display unit. Unit names matching micro_<currency> mean one millionth of that currency: $1 / USD 1 with unit micro_usd is value 1000000. If the user gives a currency and the matching unit is absent, return "unsupported_field". If the user asks for cost without a currency/unit and multiple cost units are available, return "clarification"; if exactly one unit is available, use it. Do not use cost leaves for tool-specific cost, model-specific cost, ranking, aggregation, or "highest cost" analysis.

# Tool execution
Tool execution is queryable only through tool_execution leaves. Use exact tool keys from Available tool executions. "Used/called/ran tool X" maps to op "exists". Count phrases map to field "callCount"; successful calls to "successCount"; failed calls/errors to "failureCount"; output length/large output to "totalOutputChars". Queryable tool execution fields are: ${TOOL_EXECUTION_FILTER_FIELDS.join(", ")}. Do not use tool_execution for tool input text, tool output contents, duration, cache hits, resource usage, or cost. tool_usage is a separate explicit resource/cost reporting concept and is not the same as ordinary tool execution.

# Time range
Default is 7d when omitted. For simple recent ranges that exactly fit the quick presets, set time_range to { "type": "preset", "preset": "1h" | "24h" | "7d" | "30d" }. For precise boundaries that presets cannot express (today, yesterday, this morning, a named date, or a date interval), set time_range to { "type": "range", "from_local": <optional>, "to_local": <optional> }.
Use Current time as the clock for relative phrases. range.from_local/range.to_local must be local wall-clock timestamps in YYYY-MM-DDTHH:mm:ss form, without a timezone suffix (for example 2026-07-01T09:00:00). Do not output date-only strings. If the user asks for a precise time range but the boundary cannot be inferred, return "clarification" instead of falling back to 7d.

# Response rules
- status "ok": filters must be present (may be [] for "everything in the last hour" style requests). Keep message to one short sentence describing the filter.
- status "clarification": the request is ambiguous in a way that changes the filter (ask one concrete question in message; omit filters).
- status "out_of_scope": the request is not a trace-list search (e.g. asking to analyze, explain, summarize, rank, or aggregate traces); say this endpoint only creates trace search filters and omit filters.
- status "unsupported_field": the request is a trace search, but it targets data that is not currently queryable by this filter AST (e.g. span/resource tags that are absent from the root-attribute catalog, service.name absent from current/root catalog attributes, span operation/name/status/duration, message text, tool-specific cost details, unknown attributes absent from both current trace attributes and the catalog, or cost units absent from the cost catalog); say which field or data area is unavailable and omit filters.
- For out_of_scope or unsupported_field, append one short "you can try ..." suggestion only when there is a reliable nearby trace-search substitute. The suggestion must name only queryable fields: builtin keys listed above, current trace attributes, catalog attributes, available model_usage model keys, available cost unit keys, or available tool_execution tool keys. If there is no reliable substitute, do not add a suggestion.
- Good substitutes: "why is this trace slow?" -> suggest searching duration > 5000; "highest cost" -> say ranking is out of scope, but suggest a cost threshold only if a relevant cost unit is available, otherwise suggest totalTokens or llmCallCount; unsupported message/span details or tool input/output details -> suggest status, errorMessage, duration, toolCallCount, llmCallCount, a relevant tool_execution metric, or a relevant catalog attribute only if it matches the request.
- Never suggest unqueryable fields such as arbitrary tool-specific cost, tool input/output contents, tool duration/cache hits, message text, service.name/resource/span tags absent from the root-attribute catalog, child span attributes, span operation/name/status/duration, or unknown attributes absent from both current trace attributes and the catalog.
- Model names are dynamic keys; if the user asks for a model not present in Available models, say that model is not currently in the queryable model catalog and omit filters.
- Cost units are dynamic keys; if the user asks for a cost unit not present in Available cost units, say that unit is not currently in the queryable cost catalog and omit filters.
- Tool names are dynamic keys; if the user asks for a tool not present in Available tool executions, say that tool is not currently in the queryable tool execution catalog and omit filters.
- Prefer current trace attributes when the user refers to "current", "this trace", "same as this", "这个", or a visible value on the current trace.
- Prefer catalog keys for general searches; if the user names an attribute not in current trace attributes or the catalog, do not compile a verbatim root_attr filter. Return "unsupported_field" instead so the UI does not show a silently empty search.
- When the user asks to add, remove, keep, change, refine, or continue from the current/previous settings, start from Current UI filter settings and return the full updated filters array and updated time_range, not only the delta.
- For analysis questions such as asking why a trace is slow, return "out_of_scope" because this endpoint only creates search filters.
      `);

      expectValidator((data: z.infer<typeof FilterAgentResponseSchema>) => {
        if (data.status !== "ok") {
          return data.message
            ? true
            : `status "${data.status}" requires a message explaining what is needed`;
        }
        if (!Array.isArray(data.filters)) {
          return 'status "ok" requires a "filters" array (may be empty)';
        }
        if (data.time_range?.type === "range") {
          if (!data.time_range.from_local && !data.time_range.to_local) {
            return 'time_range type "range" requires from_local or to_local';
          }
          for (const key of ["from_local", "to_local"] as const) {
            const value = data.time_range[key];
            if (value === undefined) continue;
            if (!now || !isLocalDateTime(now)) {
              return `time_range.${key} requires current browser local time in YYYY-MM-DDTHH:mm:ss form`;
            }
            if (!isLocalDateTime(value)) {
              return `time_range.${key} must be a local timestamp in YYYY-MM-DDTHH:mm:ss form`;
            }
          }
        }
        for (const node of data.filters) {
          const result = validateFilterNode(node);
          if (result !== true) {
            return `invalid filter node: ${result}`;
          }
        }
        return true;
      });

      const result = await promptChat({
        message: [
          ...history,
          {
            role: "user",
            content: buildFilterUserMessage({
              prompt,
              catalog,
              currentRequest,
              currentTrace,
              now,
            }),
          },
        ],
        schema: FilterAgentResponseSchema,
      });

      return {
        ...result.data,
        filters: result.data.filters as TraceFilterNode[] | undefined,
        delta: result.delta,
      };
    },
  });
}
