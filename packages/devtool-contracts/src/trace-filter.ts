import { z } from "zod/v4";

export const TRACE_FILTER_TIME_PRESETS = ["1h", "24h", "7d", "30d"] as const;

export type TraceFilterTimePreset = (typeof TRACE_FILTER_TIME_PRESETS)[number];

export const TRACE_FILTER_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "exists",
] as const;

export type TraceFilterOp = (typeof TRACE_FILTER_OPS)[number];

export const TRACE_FILTER_COMPARISON_OPS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;

export type TraceFilterComparisonOp = (typeof TRACE_FILTER_COMPARISON_OPS)[number];

export const TRACE_FILTER_NODE_KINDS = [
  "root_attr",
  "builtin",
  "model_usage",
  "cost",
  "tool_execution",
  "and",
  "or",
  "not",
] as const;

export type TraceFilterNodeKind = (typeof TRACE_FILTER_NODE_KINDS)[number];

export type TraceFilterValue = string | number | boolean | null;

export const traceFilterTimePresetSchema = z.enum(TRACE_FILTER_TIME_PRESETS);
export const traceFilterOpSchema = z.enum(TRACE_FILTER_OPS);
export const traceFilterComparisonOpSchema = z.enum(TRACE_FILTER_COMPARISON_OPS);
export const traceFilterNodeKindSchema = z.enum(TRACE_FILTER_NODE_KINDS);
export const traceFilterValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** Summary columns addressable by builtin filters. */
export const BUILTIN_FILTER_KEYS = [
  "status",
  "entryType",
  "name",
  "inputPreview",
  "outputPreview",
  "endReason",
  "errorMessage",
  "isStarred",
  "duration",
  "totalTokens",
  "llmCallCount",
  "toolCallCount",
  "generationCount",
] as const;

export type BuiltinFilterKey = (typeof BUILTIN_FILTER_KEYS)[number];

export const TOOL_EXECUTION_FILTER_FIELDS = [
  "callCount",
  "successCount",
  "failureCount",
  "totalOutputChars",
] as const;

export type ToolExecutionFilterField = (typeof TOOL_EXECUTION_FILTER_FIELDS)[number];

export const traceFilterTimeRangeSchema = z.object({
  preset: traceFilterTimePresetSchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

// Loose AST node schema for HTTP boundaries. The recursive grammar is validated
// by the server controller; this keeps runtime behavior aligned with the old route schema.
export const traceFilterHttpNodeSchema = z
  .object({
    kind: traceFilterNodeKindSchema,
  })
  .passthrough();

type TraceFilterNodeShape =
  | z.infer<typeof rootAttrFilterSchema>
  | z.infer<typeof builtinFilterSchema>
  | z.infer<typeof modelUsageFilterSchema>
  | z.infer<typeof costFilterSchema>
  | z.infer<typeof toolExecutionFilterSchema>
  | { kind: "and"; filters: TraceFilterNodeShape[] }
  | { kind: "or"; filters: TraceFilterNodeShape[] }
  | { kind: "not"; filter: TraceFilterNodeShape };

export const rootAttrFilterSchema = z.union([
  z.object({
    kind: z.literal("root_attr"),
    key: z.string().min(1),
    op: z.literal("exists"),
    value: z.never().optional(),
  }),
  z.object({
    kind: z.literal("root_attr"),
    key: z.string().min(1),
    op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains"]),
    value: traceFilterValueSchema,
  }),
]);

export const builtinFilterSchema = z.union([
  z.object({
    kind: z.literal("builtin"),
    key: z.enum(BUILTIN_FILTER_KEYS),
    op: z.literal("exists"),
    value: z.never().optional(),
  }),
  z.object({
    kind: z.literal("builtin"),
    key: z.enum(BUILTIN_FILTER_KEYS),
    op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains"]),
    value: traceFilterValueSchema,
  }),
]);

export const modelUsageFilterSchema = z.union([
  z.object({
    kind: z.literal("model_usage"),
    model: z.string().min(1),
    op: z.literal("exists"),
    field: z.never().optional(),
    value: z.never().optional(),
  }),
  z.object({
    kind: z.literal("model_usage"),
    model: z.string().min(1),
    field: z.literal("count"),
    op: traceFilterComparisonOpSchema,
    value: z.number().finite(),
  }),
]);

export const costFilterSchema = z.union([
  z.object({
    kind: z.literal("cost"),
    unit: z.string().min(1),
    op: z.literal("exists"),
    value: z.never().optional(),
  }),
  z.object({
    kind: z.literal("cost"),
    unit: z.string().min(1),
    op: traceFilterComparisonOpSchema,
    value: z.number().finite(),
  }),
]);

export const toolExecutionFilterSchema = z.union([
  z.object({
    kind: z.literal("tool_execution"),
    tool: z.string().min(1),
    op: z.literal("exists"),
    field: z.never().optional(),
    value: z.never().optional(),
  }),
  z.object({
    kind: z.literal("tool_execution"),
    tool: z.string().min(1),
    field: z.enum(TOOL_EXECUTION_FILTER_FIELDS),
    op: traceFilterComparisonOpSchema,
    value: z.number().finite(),
  }),
]);

export const traceFilterNodeSchema: z.ZodType<TraceFilterNodeShape> = z.lazy(() =>
  z.union([
    rootAttrFilterSchema,
    builtinFilterSchema,
    modelUsageFilterSchema,
    costFilterSchema,
    toolExecutionFilterSchema,
    z.object({
      kind: z.literal("and"),
      filters: z.array(traceFilterNodeSchema).min(1).max(20),
    }),
    z.object({
      kind: z.literal("or"),
      filters: z.array(traceFilterNodeSchema).min(1).max(20),
    }),
    z.object({
      kind: z.literal("not"),
      filter: traceFilterNodeSchema,
    }),
  ]),
);

export const traceFilterRequestSchema = z.object({
  timeRange: traceFilterTimeRangeSchema.optional(),
  filters: z.array(traceFilterNodeSchema),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

export const traceFilterHttpRequestSchema = z.object({
  timeRange: traceFilterTimeRangeSchema.optional(),
  filters: z.array(traceFilterHttpNodeSchema),
  limit: z.number().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

export type RootAttrFilter = z.infer<typeof rootAttrFilterSchema>;
export type RootAttrEqFilter = Extract<RootAttrFilter, { op: "eq" }>;
export type BuiltinFilter = z.infer<typeof builtinFilterSchema>;
export type ModelUsageFilter = z.infer<typeof modelUsageFilterSchema>;
export type CostFilter = z.infer<typeof costFilterSchema>;
export type ToolExecutionFilter = z.infer<typeof toolExecutionFilterSchema>;
export type TraceFilterNode = z.infer<typeof traceFilterNodeSchema>;
export type TraceFilterRequest = z.infer<typeof traceFilterRequestSchema>;

/** Opaque chat message round-tripped between filter generation calls. */
export type TraceFilterChatMessage = Record<string, unknown>;

export const traceFilterGenerateContextSchema = z
  .object({
    traceId: z.string().nullable().optional(),
    currentRequest: z.custom<TraceFilterRequest>().nullable().optional(),
    now: z.string().nullable().optional(),
  })
  .passthrough();

export const traceFilterGenerateRequestSchema = z.object({
  prompt: z.string(),
  history: z.array(z.record(z.string(), z.unknown())).optional(),
  context: traceFilterGenerateContextSchema.nullable().optional(),
});

export const traceFilterGenerateTimeRangeSchema = z.union([
  z.object({
    type: z.literal("preset"),
    preset: traceFilterTimePresetSchema,
  }),
  z.object({
    type: z.literal("range"),
    from: z.string().optional(),
    to: z.string().optional(),
  }),
]);

export const traceFilterGenerateResponseSchema = z.object({
  status: z.enum(["ok", "clarification", "out_of_scope", "unsupported_field"]),
  message: z.string().optional(),
  time_range: traceFilterGenerateTimeRangeSchema.optional(),
  filters: z.array(traceFilterNodeSchema).optional(),
  delta: z.array(z.record(z.string(), z.unknown())),
});

export type TraceFilterGenerateContext = z.infer<typeof traceFilterGenerateContextSchema>;
export type TraceFilterGenerateRequest = z.infer<typeof traceFilterGenerateRequestSchema>;
export type TraceFilterGenerateTimeRange = z.infer<typeof traceFilterGenerateTimeRangeSchema>;
export type TraceFilterGenerateResponse = z.infer<typeof traceFilterGenerateResponseSchema>;
