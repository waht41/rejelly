import { z } from "zod/v4";

export const traceEntryTypeSchema = z.enum(["agent", "script", "unknown"]);
export const traceStatusSchema = z.enum(["running", "completed", "failed"]);
export const traceEndReasonSchema = z
  .enum(["success", "error", "budget_exceeded", "interrupted"])
  .nullable();
export const traceNameSourceSchema = z.enum(["trace", "user"]);

export const traceSummarySchema = z.object({
  traceId: z.string(),
  name: z.string(),
  nameSource: traceNameSourceSchema,
  entryType: traceEntryTypeSchema,
  entrySpanId: z.string().nullable(),
  inputPreview: z.string().nullable(),
  outputPreview: z.string().nullable(),
  status: traceStatusSchema,
  endReason: traceEndReasonSchema,
  errorMessage: z.string().nullable(),
  timestamp: z.number(),
  duration: z.number().nullable(),
  totalTokens: z.number().nullable(),
  costs: z.string().nullable(),
  generationCount: z.number(),
  llmCallCount: z.number(),
  toolCallCount: z.number(),
  toolExecutions: z.string().nullable(),
  toolUsage: z.string().nullable(),
  llmUsage: z.string().nullable(),
  isStarred: z.boolean(),
  tags: z.string().nullable(),
});

export const traceDetailSchema = traceSummarySchema.extend({
  outputFull: z.string().nullable(),
  errorFull: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const listTracesResponseSchema = z.object({
  items: z.array(traceSummarySchema),
  total: z.number().nullable().optional(),
  page: z.number(),
  pageSize: z.number(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable().optional(),
});

export const listTracesQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).optional(),
  page: z.coerce.number().int().min(1).optional(),
  status: z.string().optional(),
  entryType: z.string().optional(),
  name: z.string().optional(),
  isStarred: z
    .preprocess((value) => {
      if (value === "true") return true;
      if (value === "false") return false;
      return value;
    }, z.boolean())
    .optional(),
  startTime: z.coerce.number().int().min(0).optional(),
  endTime: z.coerce.number().int().min(0).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

export const traceSummaryPatchSchema = z.object({
  name: z.string().optional(),
  isStarred: z.boolean().optional(),
  tags: z.array(z.string()).nullable().optional(),
});

export type TraceEntryType = z.infer<typeof traceEntryTypeSchema>;
export type TraceStatus = z.infer<typeof traceStatusSchema>;
export type TraceEndReason = z.infer<typeof traceEndReasonSchema>;
export type TraceNameSource = z.infer<typeof traceNameSourceSchema>;
export type TraceSummary = z.infer<typeof traceSummarySchema>;
export type TraceDetail = z.infer<typeof traceDetailSchema>;
export type ListTracesResponse = z.infer<typeof listTracesResponseSchema>;
export type ListTracesQuery = z.infer<typeof listTracesQuerySchema>;
export type TraceSummaryPatch = z.infer<typeof traceSummaryPatchSchema>;
