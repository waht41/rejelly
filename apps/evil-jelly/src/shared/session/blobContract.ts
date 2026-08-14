import { z } from "zod";

export const SESSION_BLOB_SCHEME = "rejelly-blob://";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

declare const sessionBlobRefBrand: unique symbol;
export type SessionBlobRef = string & { readonly [sessionBlobRefBrand]: true };

export const sessionBlobRefSchema = z
  .string()
  .refine(
    (value) => {
      if (!value.startsWith(SESSION_BLOB_SCHEME)) {
        return false;
      }
      return SHA256_PATTERN.test(value.slice(SESSION_BLOB_SCHEME.length));
    },
    { message: "Invalid session blob reference" },
  )
  .transform((value) => value as SessionBlobRef);

export const sessionBlobMetadataSchema = z
  .object({
    blobRef: sessionBlobRefSchema,
    sha256: z.string().regex(SHA256_PATTERN),
    mediaType: z
      .string()
      .min(1)
      .refine((value) => !/[\r\n]/.test(value), "mediaType must not contain newlines"),
    byteLength: z.number().int().nonnegative(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    sourcePath: z.string().optional(),
  })
  .passthrough()
  .superRefine((metadata, context) => {
    if (metadata.blobRef !== `${SESSION_BLOB_SCHEME}${metadata.sha256}`) {
      context.addIssue({
        code: "custom",
        path: ["blobRef"],
        message: "blobRef must contain the declared sha256",
      });
    }
  });

export type SessionBlobMetadata = z.infer<typeof sessionBlobMetadataSchema>;

export const sessionImageBlobMetadataMapSchema = z.record(z.string(), sessionBlobMetadataSchema);

export function sessionBlobDigest(blobRef: string): string {
  const parsed = sessionBlobRefSchema.safeParse(blobRef);
  if (!parsed.success) {
    throw new Error(`Invalid session blob reference: ${blobRef}`);
  }
  return parsed.data.slice(SESSION_BLOB_SCHEME.length);
}
