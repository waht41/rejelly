import { z } from "zod";
import type { PromptDocument, PromptNode } from "../../../shared/model/prompt/promptDocument";
import { PROMPT_IMAGE_MIME_TYPES } from "../../../shared/model/prompt/promptInput";
import { type SessionBlobRef, sessionBlobRefSchema } from "../../../shared/session/blobContract";

export type StoredPromptNodeV1 = PromptNode;

export interface StoredPromptDocumentV1 {
  version: 1;
  nodes: StoredPromptNodeV1[];
}

export type StoredPromptAttachmentV1 =
  | { version: 1; id: string; kind: "file"; path: string }
  | {
      version: 1;
      id: string;
      kind: "image";
      blobRef: SessionBlobRef;
      mediaType: (typeof PROMPT_IMAGE_MIME_TYPES)[number];
      byteLength: number;
      width?: number;
      height?: number;
      detail?: "auto" | "low" | "high";
    };

export interface StoredPromptInputV1 {
  document: StoredPromptDocumentV1;
  attachments: StoredPromptAttachmentV1[];
}

const nonBlankStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "Value must not be blank");

const storedPromptTextNodeV1Schema = z
  .object({ type: z.literal("text"), text: z.string().min(1) })
  .strict();
const storedSkillPromptTokenV1Schema = z
  .object({
    type: z.literal("token"),
    kind: z.literal("skill"),
    qualifiedName: nonBlankStringSchema,
  })
  .strict();
const storedPastePromptTokenV1Schema = z
  .object({ type: z.literal("token"), kind: z.literal("paste"), text: z.string().min(1) })
  .strict();
const storedFilePromptTokenV1Schema = z
  .object({
    type: z.literal("token"),
    kind: z.literal("file"),
    attachmentId: nonBlankStringSchema,
  })
  .strict();
const storedImagePromptTokenV1Schema = z
  .object({
    type: z.literal("token"),
    kind: z.literal("image"),
    attachmentId: nonBlankStringSchema,
  })
  .strict();

export const storedPromptNodeV1Schema = z.union([
  storedPromptTextNodeV1Schema,
  storedSkillPromptTokenV1Schema,
  storedPastePromptTokenV1Schema,
  storedFilePromptTokenV1Schema,
  storedImagePromptTokenV1Schema,
]);

export const storedPromptDocumentV1Schema = z
  .object({
    version: z.literal(1),
    nodes: z.array(storedPromptNodeV1Schema),
  })
  .strict()
  .superRefine((document, context) => {
    document.nodes.forEach((node, index) => {
      if (node.type === "text" && document.nodes[index - 1]?.type === "text") {
        context.addIssue({
          code: "custom",
          path: ["nodes", index],
          message: "Stored prompt document must merge adjacent text nodes",
        });
      }
    });
  });

const storedPromptFileAttachmentV1Schema = z
  .object({
    version: z.literal(1),
    id: nonBlankStringSchema,
    kind: z.literal("file"),
    path: nonBlankStringSchema,
  })
  .strict();

const storedPromptImageAttachmentV1Schema = z
  .object({
    version: z.literal(1),
    id: nonBlankStringSchema,
    kind: z.literal("image"),
    blobRef: sessionBlobRefSchema,
    mediaType: z.enum(PROMPT_IMAGE_MIME_TYPES),
    byteLength: z.number().int().nonnegative(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    detail: z.enum(["auto", "low", "high"]).optional(),
  })
  .strict();

export const storedPromptAttachmentV1Schema: z.ZodType<
  StoredPromptAttachmentV1,
  z.ZodTypeDef,
  unknown
> = z.discriminatedUnion("kind", [
  storedPromptFileAttachmentV1Schema,
  storedPromptImageAttachmentV1Schema,
]);

export const storedPromptInputV1Schema: z.ZodType<StoredPromptInputV1, z.ZodTypeDef, unknown> = z
  .object({
    document: storedPromptDocumentV1Schema,
    attachments: z.array(storedPromptAttachmentV1Schema),
  })
  .strict()
  .superRefine((input, context) => {
    const attachments = new Map<string, "file" | "image">();
    input.attachments.forEach((attachment, index) => {
      if (attachments.has(attachment.id)) {
        context.addIssue({
          code: "custom",
          path: ["attachments", index, "id"],
          message: `Duplicate prompt attachment id: ${attachment.id}`,
        });
      }
      attachments.set(attachment.id, attachment.kind);
    });

    const references = new Set<string>();
    input.document.nodes.forEach((node, index) => {
      if (node.type !== "token" || (node.kind !== "file" && node.kind !== "image")) {
        return;
      }
      references.add(node.attachmentId);
      const kind = attachments.get(node.attachmentId);
      if (kind !== node.kind) {
        context.addIssue({
          code: "custom",
          path: ["document", "nodes", index, "attachmentId"],
          message: kind
            ? `Prompt token expects ${node.kind} attachment, received ${kind}`
            : `Missing ${node.kind} attachment: ${node.attachmentId}`,
        });
      }
    });

    input.attachments.forEach((attachment, index) => {
      if (!references.has(attachment.id)) {
        context.addIssue({
          code: "custom",
          path: ["attachments", index, "id"],
          message: `Unreferenced prompt attachment: ${attachment.id}`,
        });
      }
    });
  });

/** Encode a canonical semantic document without admitting UI-only fields. */
export function encodeStoredPromptDocumentV1(document: PromptDocument): StoredPromptDocumentV1 {
  return storedPromptDocumentV1Schema.parse({ version: 1, nodes: document });
}

export function decodeStoredPromptDocumentV1(value: unknown): PromptDocument {
  return storedPromptDocumentV1Schema.parse(value).nodes;
}

export function parseStoredPromptInputV1(value: unknown): StoredPromptInputV1 {
  return storedPromptInputV1Schema.parse(value);
}

/** Stable user-facing text projection; never inspects materialized Message text. */
export function storedPromptInputPlainText(input: StoredPromptInputV1): string {
  const parsed = parseStoredPromptInputV1(input);
  const attachments = new Map(parsed.attachments.map((attachment) => [attachment.id, attachment]));
  let imageIndex = 0;
  return parsed.document.nodes
    .map((node) => {
      if (node.type === "text") return node.text;
      switch (node.kind) {
        case "paste":
          return node.text;
        case "skill":
          return `$${node.qualifiedName}`;
        case "file": {
          const attachment = attachments.get(node.attachmentId);
          return attachment?.kind === "file" ? `@${attachment.path}` : "[File]";
        }
        case "image":
          imageIndex += 1;
          return `[Image #${imageIndex}]`;
        default:
          throw new Error(`Unknown stored prompt node: ${JSON.stringify(node)}`);
      }
    })
    .join("");
}
