import crypto from "node:crypto";
import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { ContentPart, Message } from "@rejelly/core";
import { z } from "zod";
import { resolveGlobalJellyDir } from "../../shared/globalPath";
import { readImageDimensions } from "../../shared/lib/imageDimensions";

export const SESSION_BLOB_SCHEME = "rejelly-blob://";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATA_IMAGE_PATTERN = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/;

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

export interface SessionBlobStoreOptions {
  blobRoot?: string;
}

function resolveBlobRoot(options: SessionBlobStoreOptions): string {
  return options.blobRoot ?? path.join(resolveGlobalJellyDir(), "blobs");
}

function digestBytes(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function blobPath(sha256: string, options: SessionBlobStoreOptions): string {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`Invalid session blob digest: ${sha256}`);
  }
  return path.join(resolveBlobRoot(options), sha256);
}

async function syncBlobDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") {
    // Node does not portably expose FlushFileBuffers for directory handles on Windows.
    return;
  }
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseBlobRef(blobRef: string): string {
  const parsed = sessionBlobRefSchema.safeParse(blobRef);
  if (!parsed.success) {
    throw new Error(`Invalid session blob reference: ${blobRef}`);
  }
  return parsed.data.slice(SESSION_BLOB_SCHEME.length);
}

async function verifyExistingBlob(
  filePath: string,
  expectedDigest: string,
  expectedBytes: number,
): Promise<void> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size !== expectedBytes) {
    throw new Error(`Existing session blob does not match ${expectedDigest}`);
  }
  const existing = await readFile(filePath);
  if (digestBytes(existing) !== expectedDigest) {
    throw new Error(`Existing session blob failed digest verification: ${expectedDigest}`);
  }
}

export async function persistSessionBlob(
  bytes: Uint8Array,
  mediaType: string,
  options: SessionBlobStoreOptions & { sourcePath?: string } = {},
): Promise<SessionBlobMetadata> {
  if (!mediaType || /[\r\n]/.test(mediaType)) {
    throw new Error(`Invalid blob media type: ${JSON.stringify(mediaType)}`);
  }
  const buffer = Buffer.from(bytes);
  const sha256 = digestBytes(buffer);
  const root = resolveBlobRoot(options);
  const destination = blobPath(sha256, options);
  await mkdir(root, { recursive: true, mode: 0o700 });

  try {
    await verifyExistingBlob(destination, sha256, buffer.length);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const temporary = path.join(
      root,
      `.${sha256}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(buffer);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, destination);
      await syncBlobDirectory(root);
    } catch (linkError: unknown) {
      if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") {
        throw linkError;
      }
      await verifyExistingBlob(destination, sha256, buffer.length);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  const dimensions = mediaType.startsWith("image/") ? readImageDimensions(buffer) : undefined;
  return {
    blobRef: `${SESSION_BLOB_SCHEME}${sha256}` as SessionBlobRef,
    sha256,
    mediaType,
    byteLength: buffer.length,
    ...(dimensions ?? {}),
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
  };
}

export async function readSessionBlob(
  blobRef: string,
  options: SessionBlobStoreOptions = {},
): Promise<Buffer> {
  const sha256 = parseBlobRef(blobRef);
  const bytes = await readFile(blobPath(sha256, options));
  if (digestBytes(bytes) !== sha256) {
    throw new Error(`Session blob failed digest verification: ${sha256}`);
  }
  return bytes;
}

function dataImage(url: string): { mediaType: string; bytes: Buffer } | undefined {
  const match = DATA_IMAGE_PATTERN.exec(url);
  if (!match) {
    return undefined;
  }
  const mediaType = match[1]!;
  if (!mediaType.startsWith("image/")) {
    throw new Error(`Expected image data URL, received ${mediaType}`);
  }
  return { mediaType, bytes: Buffer.from(match[2]!, "base64") };
}

function rejellyMetadata(extra: Message["extra"]): Record<string, unknown> {
  const existing = extra?.rejelly;
  if (existing === undefined) {
    return {};
  }
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    throw new Error("Message extra.rejelly must be an object before persisting session images");
  }
  return existing as Record<string, unknown>;
}

/**
 * Return the durable on-disk form of a Message. Inline image data is copied into the
 * content-addressed store before its URL is replaced by an internal locator.
 */
export async function persistMessageImageBlobs(
  message: Message,
  options: SessionBlobStoreOptions = {},
): Promise<Message> {
  if (!Array.isArray(message.content)) {
    return message;
  }
  const existingImageBlobs = imageBlobMetadata(message);
  const imageBlobs: Record<string, SessionBlobMetadata> = {};
  let changed = false;
  const content: ContentPart[] = [];
  for (const part of message.content) {
    if (part.type !== "image") {
      content.push(part);
      continue;
    }
    if (part.image.url.startsWith(SESSION_BLOB_SCHEME)) {
      const existing = existingImageBlobs[part.image.url];
      parseBlobRef(part.image.url);
      if (!existing) {
        throw new Error(`Missing metadata for session image blob ${part.image.url}`);
      }
      await readSessionBlob(part.image.url, options);
      imageBlobs[part.image.url] = existing;
      content.push(part);
      continue;
    }
    const parsed = dataImage(part.image.url);
    if (!parsed) {
      content.push(part);
      continue;
    }
    const blob = await persistSessionBlob(parsed.bytes, parsed.mediaType, options);
    imageBlobs[blob.blobRef] = blob;
    content.push({
      ...part,
      image: {
        ...part.image,
        url: blob.blobRef,
      },
    });
    changed = true;
  }
  if (!changed) {
    return message;
  }
  return {
    ...message,
    content,
    extra: {
      ...message.extra,
      rejelly: {
        ...rejellyMetadata(message.extra),
        imageBlobs,
      },
    },
  };
}

function imageBlobMetadata(message: Message): Record<string, SessionBlobMetadata> {
  const value = rejellyMetadata(message.extra).imageBlobs;
  if (value === undefined) {
    return {};
  }
  const parsed = sessionImageBlobMetadataMapSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid session image blob metadata");
  }
  for (const [blobRef, metadata] of Object.entries(parsed.data)) {
    if (!metadata) {
      throw new Error(`Missing session image blob metadata for ${blobRef}`);
    }
    if (blobRef !== metadata.blobRef) {
      throw new Error(`Session image blob metadata key does not match ${metadata.blobRef}`);
    }
  }
  return parsed.data;
}

/** Resolve internal image locators immediately before building a provider request. */
export async function materializeMessageImageBlobs(
  message: Message,
  options: SessionBlobStoreOptions = {},
): Promise<Message> {
  if (!Array.isArray(message.content)) {
    return message;
  }
  const metadata = imageBlobMetadata(message);
  let changed = false;
  const content: ContentPart[] = [];
  for (const part of message.content) {
    if (part.type !== "image") {
      content.push(part);
      continue;
    }
    if (!part.image.url.startsWith(SESSION_BLOB_SCHEME)) {
      content.push(part);
      continue;
    }
    const entry = metadata[part.image.url];
    if (!entry || !entry.mediaType.startsWith("image/")) {
      throw new Error(`Missing image media type for session blob ${part.image.url}`);
    }
    const bytes = await readSessionBlob(part.image.url, options);
    content.push({
      ...part,
      image: {
        ...part.image,
        url: `data:${entry.mediaType};base64,${bytes.toString("base64")}`,
      },
    });
    changed = true;
  }
  return changed ? { ...message, content } : message;
}

export async function materializeMessageHistory(
  messages: Message[],
  options: SessionBlobStoreOptions = {},
): Promise<Message[]> {
  return Promise.all(messages.map((message) => materializeMessageImageBlobs(message, options)));
}
