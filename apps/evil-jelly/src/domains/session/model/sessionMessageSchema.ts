import type { Message } from "@rejelly/core";
import { z } from "zod";

const jsonObjectSchema = z.record(z.string(), z.unknown());

const toolCallSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    arguments: z.string(),
    extra: jsonObjectSchema.optional(),
  })
  .passthrough();

const contentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
  z
    .object({
      type: z.literal("image"),
      image: z
        .object({
          url: z.string(),
          detail: z.enum(["auto", "low", "high"]).optional(),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("video"),
      video: z.object({ url: z.string() }).passthrough(),
    })
    .passthrough(),
]);

export const sessionMessageSchema: z.ZodType<Message> = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(contentPartSchema)]).nullable(),
    reasoning_content: z.string().optional(),
    tool_calls: z.array(toolCallSchema).optional(),
    tool_call_id: z.string().optional(),
    name: z.string().optional(),
    extra: jsonObjectSchema.optional(),
  })
  .passthrough();
