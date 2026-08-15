import { z } from "zod";

/**
 * Who authored a recorded message. Shared because both the durable session wire format and the
 * policy layer that emits messages have to name it, and neither owns the other.
 */
export const userInputMessageSourceSchema = z
  .object({
    kind: z.literal("user_input"),
    /**
     * initial starts a top-level turn; steer is additional user-authored context injected while
     * that same turn is still running.
     */
    inputKind: z.enum(["initial", "steer"]),
  })
  .passthrough();

const nonUserMessageSourceSchemas = [
  z.object({ kind: z.literal("model") }).passthrough(),
  z.object({ kind: z.literal("tool") }).passthrough(),
  z.object({ kind: z.literal("agent_runtime") }).passthrough(),
  z.object({ kind: z.literal("recovery") }).passthrough(),
] as const;

export const nonUserMessageSourceSchema = z.discriminatedUnion("kind", nonUserMessageSourceSchemas);
export const messageSourceSchema = z.discriminatedUnion("kind", [
  userInputMessageSourceSchema,
  ...nonUserMessageSourceSchemas,
]);

export type MessageSource = z.infer<typeof messageSourceSchema>;
export type NonUserMessageSource = z.infer<typeof nonUserMessageSourceSchema>;
