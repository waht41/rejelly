import { z } from "zod/v4";

export const analyzeMessageRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

export const analyzeContentPartSchema = z.union([
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    image: z.object({
      url: z.string(),
      detail: z.enum(["auto", "low", "high"]).optional(),
    }),
  }),
  z.object({
    type: z.literal("video"),
    video: z.object({
      url: z.string(),
    }),
  }),
]);

export const analyzeToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

export const analyzeContextSchema = z
  .object({
    traceId: z.string().nullable().optional(),
    conversationId: z.string().nullable().optional(),
    activeNodeId: z.string().nullable().optional(),
    activeNodeType: z.string().nullable().optional(),
  })
  .passthrough();

const analyzeChatMessageFields = {
  content: z.union([z.string(), z.array(analyzeContentPartSchema), z.null()]),
  reasoning_content: z.string().optional(),
  tool_calls: z.array(analyzeToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
};

export const analyzeChatMessageSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"),
    ...analyzeChatMessageFields,
    context: analyzeContextSchema.optional(),
  }),
  z.object({
    role: z.enum(["system", "assistant", "tool"]),
    ...analyzeChatMessageFields,
  }),
]);

export const analyzeRequestSchema = z.object({
  question: z.string(),
  history: z.array(analyzeChatMessageSchema).optional(),
  context: analyzeContextSchema.nullable().optional(),
});

export const analyzeResponseSchema = z.object({
  message: z.string(),
  delta: z.array(analyzeChatMessageSchema),
});

export const analyzeReasoningDeltaUpdateSchema = z.object({
  type: z.literal("reasoning_delta"),
  content: z.string(),
});

export const analyzeToolCallUpdateSchema = z.object({
  type: z.literal("tool_call"),
  toolName: z.string(),
  toolCallId: z.string().optional(),
});

export const analyzeTextDeltaUpdateSchema = z.object({
  type: z.literal("text_delta"),
  content: z.string(),
});

export const analyzeCompleteResponseSchema = z.object({
  complete: z.literal(true),
  response: analyzeResponseSchema,
});

export const analyzeErrorUpdateSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});

export type AnalyzeMessageRole = z.infer<typeof analyzeMessageRoleSchema>;
export type AnalyzeImageContent = Extract<
  z.infer<typeof analyzeContentPartSchema>,
  { type: "image" }
>["image"];
export type AnalyzeVideoContent = Extract<
  z.infer<typeof analyzeContentPartSchema>,
  { type: "video" }
>["video"];
export type AnalyzeContentPart = z.infer<typeof analyzeContentPartSchema>;
export type AnalyzeToolCall = z.infer<typeof analyzeToolCallSchema>;
export type AnalyzeChatMessage = z.infer<typeof analyzeChatMessageSchema>;
export type AnalyzeContext = z.infer<typeof analyzeContextSchema>;
export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;
export type AnalyzeResponse = z.infer<typeof analyzeResponseSchema>;
export type AnalyzeReasoningDeltaUpdate = z.infer<typeof analyzeReasoningDeltaUpdateSchema>;
export type AnalyzeToolCallUpdate = z.infer<typeof analyzeToolCallUpdateSchema>;
export type AnalyzeTextDeltaUpdate = z.infer<typeof analyzeTextDeltaUpdateSchema>;
export type AnalyzeCompleteResponse = z.infer<typeof analyzeCompleteResponseSchema>;
export type AnalyzeErrorUpdate = z.infer<typeof analyzeErrorUpdateSchema>;

export type AnalyzeStreamUpdate =
  | AnalyzeReasoningDeltaUpdate
  | AnalyzeToolCallUpdate
  | AnalyzeTextDeltaUpdate
  | AnalyzeCompleteResponse
  | AnalyzeErrorUpdate;

export type ChatMessage = AnalyzeChatMessage;
export type ReasoningDeltaUpdate = AnalyzeReasoningDeltaUpdate;
export type ToolCallUpdate = AnalyzeToolCallUpdate;
export type TextDeltaUpdate = AnalyzeTextDeltaUpdate;
export type CompleteResponse = AnalyzeCompleteResponse;
export type ErrorUpdate = AnalyzeErrorUpdate;
