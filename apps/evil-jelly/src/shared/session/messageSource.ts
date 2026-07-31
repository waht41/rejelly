import { z } from "zod";

/**
 * Who authored a recorded message. Shared because both the durable session wire format and the
 * policy layer that emits messages have to name it, and neither owns the other.
 */
export const messageSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("user_input"),
      /**
       * initial starts a top-level turn; steer is additional user-authored context injected while
       * that same turn is still running.
       */
      inputKind: z.enum(["initial", "steer"]),
    })
    .passthrough(),
  z.object({ kind: z.literal("model") }).passthrough(),
  z.object({ kind: z.literal("tool") }).passthrough(),
  z.object({ kind: z.literal("agent_runtime") }).passthrough(),
  z.object({ kind: z.literal("recovery") }).passthrough(),
]);

export type MessageSource = z.infer<typeof messageSourceSchema>;
