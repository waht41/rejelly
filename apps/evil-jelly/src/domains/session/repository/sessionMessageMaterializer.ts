import type { ContentPart, Message } from "@rejelly/core";
import { copyRuntimeUserInputMetadata } from "../../../shared/model/message/userInputMetadata";
import { SESSION_BLOB_SCHEME } from "../../../shared/session/blobContract";
import { readSessionBlob, type SessionBlobStoreOptions } from "../journal/sessionBlobStore";
import {
  getSessionImageBlobMetadata,
  type StoredSessionMessage,
} from "../model/storedSessionMessage";

/** Resolve durable session image locators immediately before building a provider request. */
export async function materializeMessageImageBlobs(
  message: Message,
  options: SessionBlobStoreOptions = {},
): Promise<Message> {
  if (!Array.isArray(message.content)) {
    return message;
  }
  const metadata = getSessionImageBlobMetadata(message);
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
  return changed ? copyRuntimeUserInputMetadata(message, { ...message, content }) : message;
}

export async function materializeMessageHistory(
  messages: readonly Message[],
  options: SessionBlobStoreOptions = {},
): Promise<Message[]> {
  return Promise.all(messages.map((message) => materializeMessageImageBlobs(message, options)));
}

export function materializeActiveContext(
  messages: readonly StoredSessionMessage[],
  options: SessionBlobStoreOptions = {},
): Promise<Message[]> {
  return materializeMessageHistory(messages, options);
}
