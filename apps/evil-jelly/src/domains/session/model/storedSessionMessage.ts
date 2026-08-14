import type { Message } from "@rejelly/core";
import {
  SESSION_BLOB_SCHEME,
  type SessionBlobMetadata,
  sessionBlobRefSchema,
  sessionImageBlobMetadataMapSchema,
} from "../../../shared/session/blobContract";
import { sessionMessageSchema } from "./sessionMessageSchema";

export type SessionImageBlobMap = Record<string, SessionBlobMetadata>;

const runtimeSessionImageBlobs = new WeakMap<Message, SessionImageBlobMap>();

export interface SessionRejellyMetadata extends Record<string, unknown> {
  imageBlobs?: SessionImageBlobMap;
}

export type StoredSessionMessage = Omit<Message, "extra"> & {
  extra?: Record<string, unknown> & {
    rejelly?: SessionRejellyMetadata;
  };
};

export function getStoredSessionRejellyMetadata(
  message: Message,
): SessionRejellyMetadata | undefined {
  const value = message.extra?.rejelly;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Stored session message extra.rejelly must be an object");
  }
  return value as SessionRejellyMetadata;
}

export function getSessionImageBlobMetadata(message: Message): Record<string, SessionBlobMetadata> {
  const runtime = runtimeSessionImageBlobs.get(message);
  if (runtime) return runtime;
  const value = getStoredSessionRejellyMetadata(message)?.imageBlobs;
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

/** Register V3 blob metadata beside a runtime Message without changing its provider wire shape. */
export function registerRuntimeSessionImageBlobs(
  message: Message,
  imageBlobs: SessionImageBlobMap,
): Message {
  if (Object.keys(imageBlobs).length > 0) {
    runtimeSessionImageBlobs.set(message, imageBlobs);
  }
  return message;
}

/**
 * The sole narrowing boundary between a Core Message and its durable Session form.
 * Provider-facing code must materialize the returned message before use.
 */
export function parseStoredSessionMessage(
  message: Message,
  options: { imageBlobs?: SessionImageBlobMap } = {},
): StoredSessionMessage {
  const parsedMessage = sessionMessageSchema.safeParse(message);
  if (!parsedMessage.success) {
    throw new Error("Invalid stored session message", { cause: parsedMessage.error });
  }

  const imageBlobs = options.imageBlobs ?? getSessionImageBlobMetadata(parsedMessage.data);

  if (Array.isArray(parsedMessage.data.content)) {
    for (const part of parsedMessage.data.content) {
      if (part.type !== "image") {
        continue;
      }
      if (part.image.url.startsWith("data:image/")) {
        throw new Error("Stored Session messages cannot contain inline image data URLs");
      }
      if (!part.image.url.startsWith(SESSION_BLOB_SCHEME)) {
        continue;
      }
      const blobRef = sessionBlobRefSchema.safeParse(part.image.url);
      if (!blobRef.success || !imageBlobs[blobRef.data]) {
        throw new Error(`Missing metadata for stored session image ${part.image.url}`);
      }
    }
  }

  const stored = parsedMessage.data as StoredSessionMessage;
  registerRuntimeSessionImageBlobs(stored, imageBlobs);
  return stored;
}
