import type { Message } from "@rejelly/core";
import type { PromptInput } from "../../../shared/model/prompt/promptInput";
import {
  assertMatchingUserInputMaterialization,
  type UserInputMaterializationV1,
} from "../../../shared/model/prompt/userInputMaterialization";
import {
  encodeStoredPromptDocumentV1,
  parseStoredPromptInputV1,
  type StoredPromptInputV1,
} from "../model/storedPromptInput";
import { getSessionImageBlobMetadata } from "../model/storedSessionMessage";
import {
  parseStoredUserInputMaterializationV1,
  type StoredTokenResolutionV1,
  type StoredUserInputMaterializationV1,
} from "../model/storedUserInputMaterialization";
import { persistMessageImageBlobs, type SessionBlobStoreOptions } from "./sessionBlobStore";

export interface PreparedStoredUserInputV1 extends StoredPromptInputV1 {
  materialized: StoredUserInputMaterializationV1;
}

function withoutTransientUserInputMetadata(message: Message): Message {
  if (!message.extra) return message;
  const { rejelly: _rejelly, ...extra } = message.extra;
  return {
    ...message,
    ...(Object.keys(extra).length > 0 ? { extra } : { extra: undefined }),
  };
}

/** Persist every image blob before constructing the stored V3 payload that can reference it. */
export async function prepareUserInputForStorage(
  input: PromptInput,
  materialization: UserInputMaterializationV1,
  options: SessionBlobStoreOptions = {},
): Promise<PreparedStoredUserInputV1> {
  assertMatchingUserInputMaterialization(input, materialization);
  const persistedMessage = await persistMessageImageBlobs(materialization.message, options);
  const imageBlobs = getSessionImageBlobMetadata(persistedMessage);
  const blobsByDigest = new Map(
    Object.values(imageBlobs).map((blob) => [blob.sha256, blob] as const),
  );

  const resolutions: StoredTokenResolutionV1[] = materialization.resolutions.map((resolution) => {
    if (resolution.kind !== "image") return { ...resolution };
    const blob = blobsByDigest.get(resolution.sha256);
    if (!blob) {
      throw new Error(`Missing persisted image metadata for ${resolution.attachmentId}`);
    }
    if (blob.mediaType !== resolution.mediaType || blob.byteLength !== resolution.byteLength) {
      throw new Error(
        `Materialized image changed before Session storage: ${resolution.attachmentId}`,
      );
    }
    return {
      version: 1,
      nodeOrdinal: resolution.nodeOrdinal,
      kind: "image",
      attachmentId: resolution.attachmentId,
      status: "resolved",
      mediaType: resolution.mediaType,
      detail: resolution.detail,
      blob,
    };
  });

  const imageByAttachmentId = new Map(
    resolutions.flatMap((resolution) =>
      resolution.kind === "image" ? [[resolution.attachmentId, resolution] as const] : [],
    ),
  );
  const storedInput = parseStoredPromptInputV1({
    document: encodeStoredPromptDocumentV1(input.document),
    attachments: input.attachments.map((attachment) => {
      if (attachment.kind === "file") {
        return {
          version: 1 as const,
          id: attachment.id,
          kind: "file" as const,
          path: attachment.path,
        };
      }
      const resolution = imageByAttachmentId.get(attachment.id);
      if (!resolution) {
        throw new Error(`Missing frozen image resolution for ${attachment.id}`);
      }
      return {
        version: 1 as const,
        id: attachment.id,
        kind: "image" as const,
        blobRef: resolution.blob.blobRef,
        mediaType: resolution.mediaType,
        byteLength: resolution.blob.byteLength,
        ...(resolution.blob.width ? { width: resolution.blob.width } : {}),
        ...(resolution.blob.height ? { height: resolution.blob.height } : {}),
        ...(resolution.detail !== "auto" ? { detail: resolution.detail } : {}),
      };
    }),
  });
  const storedMaterialization = parseStoredUserInputMaterializationV1({
    version: 1,
    message: withoutTransientUserInputMetadata(persistedMessage),
    display: materialization.display,
    resolutions,
  });
  return { ...storedInput, materialized: storedMaterialization };
}
