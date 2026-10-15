import { z } from "zod/v4";

/** DevTool-only references. Never substitute these into model input messages. */
export const ATTACHMENT_REFERENCE_PREFIX = "attachment://sha256/";
export const ATTACHMENTS_API_PATH = "/api/v1/attachments";

export const attachmentHashSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]+$/);
export const attachmentMimeTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export const attachmentUploadResponseSchema = z.object({
  id: z
    .string()
    .length(71)
    .regex(/^sha256:[a-f0-9]+$/),
  url: z.string().refine((value) => getAttachmentHash(value) !== undefined),
  mimeType: attachmentMimeTypeSchema,
  byteSize: z.number().int().positive(),
});

export type AttachmentMimeType = z.infer<typeof attachmentMimeTypeSchema>;
export type AttachmentUploadResponse = z.infer<typeof attachmentUploadResponseSchema>;

/** Reject malformed references rather than interpreting them as a URL or file path. */
export function getAttachmentHash(reference: string): string | undefined {
  if (!reference.startsWith(ATTACHMENT_REFERENCE_PREFIX)) return undefined;
  const hash = reference.slice(ATTACHMENT_REFERENCE_PREFIX.length);
  return attachmentHashSchema.safeParse(hash).success ? hash : undefined;
}
