import type { Message } from "@rejelly/core";
import {
  materializeMessageHistory,
  SESSION_BLOB_SCHEME,
  type SessionBlobMetadata,
  type SessionBlobStoreOptions,
  sessionBlobRefSchema,
  sessionImageBlobMetadataMapSchema,
} from "../../shared/blobs/sessionBlobStore";
import { sessionMessageSchema } from "./sessionEvents";

export type SessionImageBlobMap = Record<string, SessionBlobMetadata>;

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

/**
 * The sole narrowing boundary between a Core Message and its durable Session V2 form.
 * Provider-facing code must materialize the returned message before use.
 */
export function parseStoredSessionMessage(message: Message): StoredSessionMessage {
  const parsedMessage = sessionMessageSchema.safeParse(message);
  if (!parsedMessage.success) {
    throw new Error("Invalid stored session message", { cause: parsedMessage.error });
  }

  const metadata = getStoredSessionRejellyMetadata(parsedMessage.data);
  const parsedBlobs = sessionImageBlobMetadataMapSchema.safeParse(metadata?.imageBlobs ?? {});
  if (!parsedBlobs.success) {
    throw new Error("Invalid stored session image blob metadata", { cause: parsedBlobs.error });
  }
  for (const [key, blob] of Object.entries(parsedBlobs.data)) {
    if (!blob) {
      throw new Error(`Missing stored session image blob metadata for ${key}`);
    }
    if (key !== blob.blobRef) {
      throw new Error(`Session image blob metadata key does not match ${blob.blobRef}`);
    }
  }

  if (Array.isArray(parsedMessage.data.content)) {
    for (const part of parsedMessage.data.content) {
      if (part.type !== "image") {
        continue;
      }
      if (part.image.url.startsWith("data:image/")) {
        throw new Error("Stored Session V2 messages cannot contain inline image data URLs");
      }
      if (!part.image.url.startsWith(SESSION_BLOB_SCHEME)) {
        continue;
      }
      const blobRef = sessionBlobRefSchema.safeParse(part.image.url);
      if (!blobRef.success || !parsedBlobs.data[blobRef.data]) {
        throw new Error(`Missing metadata for stored session image ${part.image.url}`);
      }
    }
  }

  return parsedMessage.data as StoredSessionMessage;
}

export async function materializeActiveContext(
  messages: StoredSessionMessage[],
  options: SessionBlobStoreOptions = {},
): Promise<Message[]> {
  return materializeMessageHistory(messages, options);
}
