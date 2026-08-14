import type { Message } from "@rejelly/core";
import { z } from "zod";
import type {
  FrozenUserInputV1,
  UserInputDisplay,
} from "../../../shared/model/prompt/frozenUserInput";
import { PROMPT_IMAGE_MIME_TYPES } from "../../../shared/model/prompt/promptInput";
import {
  sessionBlobMetadataSchema,
  sessionImageBlobMetadataMapSchema,
} from "../../../shared/session/blobContract";
import { sessionMessageSchema } from "./sessionMessageSchema";

const nonBlankString = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
const fileLocatorSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("workspace"), path: z.string() }).strict(),
  z.object({ scope: z.literal("absolute"), path: z.string() }).strict(),
]);

export const userInputAttachmentDisplaySchema = z
  .object({
    type: z.enum(["file", "image"]),
    label: z.string(),
    action: z.enum(["read", "list", "attach"]),
    status: z.literal("error").optional(),
    locator: fileLocatorSchema.optional(),
  })
  .strict();

export const userInputDisplaySchema: z.ZodType<UserInputDisplay, z.ZodTypeDef, unknown> = z
  .object({
    text: z.string(),
    attachments: z.array(userInputAttachmentDisplaySchema),
  })
  .strict();

const textNodeSchema = z.object({ kind: z.literal("text"), text: z.string().min(1) }).strict();
const pasteNodeSchema = z.object({ kind: z.literal("paste"), text: z.string().min(1) }).strict();
const skillNodeSchema = z
  .object({
    kind: z.literal("skill"),
    qualifiedName: nonBlankString,
    status: z.enum(["resolved", "unavailable"]),
    context: z.string().optional(),
  })
  .strict()
  .superRefine((node, context) => {
    if (node.status === "resolved" && node.context === undefined) {
      context.addIssue({
        code: "custom",
        path: ["context"],
        message: "Resolved Skill needs context",
      });
    }
    if (node.status === "unavailable" && node.context !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["context"],
        message: "Unavailable Skill cannot have context",
      });
    }
  });
const fileNodeSchema = z
  .object({
    kind: z.literal("file"),
    path: nonBlankString,
    action: z.enum(["read", "list", "attach"]),
    status: z.enum(["resolved", "error"]),
    context: z.string(),
    locator: fileLocatorSchema.optional(),
  })
  .strict();
const imageNodeSchema = z
  .object({
    kind: z.literal("image"),
    blob: sessionBlobMetadataSchema,
    detail: z.enum(["auto", "low", "high"]),
  })
  .strict()
  .superRefine((node, context) => {
    if (!(PROMPT_IMAGE_MIME_TYPES as readonly string[]).includes(node.blob.mediaType)) {
      context.addIssue({
        code: "custom",
        path: ["blob", "mediaType"],
        message: "Frozen image has an unsupported media type",
      });
    }
  });

const resolvedNodeSchema = z.union([
  textNodeSchema,
  pasteNodeSchema,
  skillNodeSchema,
  fileNodeSchema,
  imageNodeSchema,
]);
const resolvedInputSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("resolved"),
    nodes: z.array(resolvedNodeSchema),
  })
  .strict();
const legacyInputSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("legacy"),
    display: userInputDisplaySchema,
    message: sessionMessageSchema.refine((message) => message.role === "user"),
    imageBlobs: sessionImageBlobMetadataMapSchema,
  })
  .strict();

export const frozenUserInputV1Schema: z.ZodType<FrozenUserInputV1, z.ZodTypeDef, unknown> = z.union(
  [resolvedInputSchema, legacyInputSchema],
);

export function parseFrozenUserInputV1(value: unknown): FrozenUserInputV1 {
  return frozenUserInputV1Schema.parse(value);
}

const legacyUserInputMetadataSchema = z.object({
  kind: z.literal("user_input"),
  display: userInputDisplaySchema,
});

/** V1/V2 compatibility only. */
export function getLegacyUserInputDisplay(message: Message): UserInputDisplay | undefined {
  const parsed = legacyUserInputMetadataSchema.safeParse(message.extra?.rejelly);
  return parsed.success ? parsed.data.display : undefined;
}
