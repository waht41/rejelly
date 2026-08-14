import type { Message } from "@rejelly/core";
import { z } from "zod";
import {
  type UserInputDisplay,
  userInputDisplaySchema,
} from "../../../shared/model/message/userInputMetadata";
import { PROMPT_IMAGE_MIME_TYPES } from "../../../shared/model/prompt/promptInput";
import {
  SESSION_BLOB_SCHEME,
  type SessionBlobMetadata,
  sessionBlobMetadataSchema,
} from "../../../shared/session/blobContract";
import { sessionMessageSchema } from "./sessionMessageSchema";
import {
  parseStoredPromptInputV1,
  type StoredPromptInputV1,
  storedPromptInputPlainText,
} from "./storedPromptInput";

const resolutionBase = {
  version: z.literal(1),
  nodeOrdinal: z.number().int().nonnegative(),
};

const storedSkillResolutionV1Schema = z
  .object({
    ...resolutionBase,
    kind: z.literal("skill"),
    qualifiedName: z.string().min(1),
    status: z.enum(["resolved", "unavailable"]),
    context: z.string().optional(),
  })
  .strict();

const storedFileResolutionV1Schema = z
  .object({
    ...resolutionBase,
    kind: z.literal("file"),
    attachmentId: z.string().min(1),
    status: z.enum(["resolved", "error"]),
    context: z.string(),
  })
  .strict();

const storedImageResolutionV1Schema = z
  .object({
    ...resolutionBase,
    kind: z.literal("image"),
    attachmentId: z.string().min(1),
    status: z.literal("resolved"),
    mediaType: z.enum(PROMPT_IMAGE_MIME_TYPES),
    detail: z.enum(["auto", "low", "high"]),
    blob: sessionBlobMetadataSchema,
  })
  .strict();

/** Conservative V2 migration record for an image that has no provable semantic token. */
const storedLegacyImageResolutionV1Schema = z
  .object({
    version: z.literal(1),
    kind: z.literal("legacy_image"),
    contentPartIndex: z.number().int().nonnegative(),
    detail: z.enum(["auto", "low", "high"]).optional(),
    blob: sessionBlobMetadataSchema,
  })
  .strict();

export type StoredTokenResolutionV1 =
  | {
      version: 1;
      nodeOrdinal: number;
      kind: "skill";
      qualifiedName: string;
      status: "resolved" | "unavailable";
      context?: string;
    }
  | {
      version: 1;
      nodeOrdinal: number;
      kind: "file";
      attachmentId: string;
      status: "resolved" | "error";
      context: string;
    }
  | {
      version: 1;
      nodeOrdinal: number;
      kind: "image";
      attachmentId: string;
      status: "resolved";
      mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      detail: "auto" | "low" | "high";
      blob: SessionBlobMetadata;
    }
  | {
      version: 1;
      kind: "legacy_image";
      contentPartIndex: number;
      detail?: "auto" | "low" | "high";
      blob: SessionBlobMetadata;
    };

export const storedTokenResolutionV1Schema: z.ZodType<
  StoredTokenResolutionV1,
  z.ZodTypeDef,
  unknown
> = z.discriminatedUnion("kind", [
  storedSkillResolutionV1Schema,
  storedFileResolutionV1Schema,
  storedImageResolutionV1Schema,
  storedLegacyImageResolutionV1Schema,
]);

export interface StoredUserInputMaterializationV1 {
  version: 1;
  message: Message;
  display: UserInputDisplay;
  resolutions: StoredTokenResolutionV1[];
}

const storedUserMessageSchema = sessionMessageSchema.refine((message) => message.role === "user", {
  message: "Stored user-input materialization must contain a user Message",
});

export const storedUserInputMaterializationV1Schema: z.ZodType<
  StoredUserInputMaterializationV1,
  z.ZodTypeDef,
  unknown
> = z
  .object({
    version: z.literal(1),
    message: storedUserMessageSchema,
    display: userInputDisplaySchema,
    resolutions: z.array(storedTokenResolutionV1Schema),
  })
  .strict()
  .superRefine((materialized, context) => {
    const rejelly = materialized.message.extra?.rejelly;
    if (typeof rejelly === "object" && rejelly !== null) {
      for (const key of ["kind", "display", "imageDimensions", "imageBlobs"]) {
        if (key in rejelly) {
          context.addIssue({
            code: "custom",
            path: ["message", "extra", "rejelly", key],
            message: `User-input Session metadata must live beside materialized.message: ${key}`,
          });
        }
      }
    }

    const imageParts = Array.isArray(materialized.message.content)
      ? materialized.message.content
          .map((part, contentPartIndex) => ({ part, contentPartIndex }))
          .filter(({ part }) => part.type === "image")
      : [];
    const resolvedBlobs = new Map<string, SessionBlobMetadata>();
    const legacyResolutionByPart = new Map<number, SessionBlobMetadata>();
    for (const resolution of materialized.resolutions) {
      if (resolution.kind === "image") {
        resolvedBlobs.set(resolution.blob.blobRef, resolution.blob);
      } else if (resolution.kind === "legacy_image") {
        legacyResolutionByPart.set(resolution.contentPartIndex, resolution.blob);
      }
    }
    for (const { part, contentPartIndex } of imageParts) {
      if (part.type !== "image") continue;
      if (!part.image.url.startsWith(SESSION_BLOB_SCHEME)) {
        context.addIssue({
          code: "custom",
          path: ["message", "content", contentPartIndex, "image", "url"],
          message: "Stored user-input images must use durable blob references",
        });
        continue;
      }
      const blob =
        resolvedBlobs.get(part.image.url) ?? legacyResolutionByPart.get(contentPartIndex);
      if (!blob || blob.blobRef !== part.image.url) {
        context.addIssue({
          code: "custom",
          path: ["resolutions"],
          message: `Missing frozen image resolution for content part ${contentPartIndex}`,
        });
      }
    }
  });

export function parseStoredUserInputMaterializationV1(
  value: unknown,
): StoredUserInputMaterializationV1 {
  return storedUserInputMaterializationV1Schema.parse(value);
}

export function storedMaterializationImageBlobs(
  materialized: StoredUserInputMaterializationV1,
): Record<string, SessionBlobMetadata> {
  return Object.fromEntries(
    materialized.resolutions.flatMap((resolution) =>
      resolution.kind === "image" || resolution.kind === "legacy_image"
        ? [[resolution.blob.blobRef, resolution.blob] as const]
        : [],
    ),
  );
}

/** Reject a stored sidecar that describes different semantic nodes than its canonical document. */
export function assertMatchingStoredUserInputMaterialization(
  input: StoredPromptInputV1,
  materialized: StoredUserInputMaterializationV1,
): void {
  const parsedInput = parseStoredPromptInputV1(input);
  const parsedMaterialized = parseStoredUserInputMaterializationV1(materialized);
  if (parsedMaterialized.display.text !== storedPromptInputPlainText(parsedInput)) {
    throw new Error("Stored materialization display text does not match PromptInput document");
  }

  const semanticResolutions = parsedMaterialized.resolutions.filter(
    (resolution) => resolution.kind !== "legacy_image",
  );
  const byOrdinal = new Map(
    semanticResolutions.map((resolution) => [resolution.nodeOrdinal, resolution]),
  );
  if (byOrdinal.size !== semanticResolutions.length) {
    throw new Error("Stored materialization contains duplicate node resolutions");
  }
  const attachments = new Map(
    parsedInput.attachments.map((attachment) => [attachment.id, attachment]),
  );

  parsedInput.document.nodes.forEach((node, nodeOrdinal) => {
    const needsResolution =
      node.type === "token" &&
      (node.kind === "skill" || node.kind === "file" || node.kind === "image");
    const resolution = byOrdinal.get(nodeOrdinal);
    if (!needsResolution) {
      if (resolution)
        throw new Error(`Unexpected stored resolution for prompt node ${nodeOrdinal}`);
      return;
    }
    if (!resolution || resolution.kind !== node.kind) {
      throw new Error(`Missing stored ${node.kind} resolution for prompt node ${nodeOrdinal}`);
    }
    if (
      node.kind === "skill" &&
      resolution.kind === "skill" &&
      resolution.qualifiedName !== node.qualifiedName
    ) {
      throw new Error(`Stored Skill resolution identity mismatch at prompt node ${nodeOrdinal}`);
    }
    if (node.kind === "file" && resolution.kind === "file") {
      if (resolution.attachmentId !== node.attachmentId) {
        throw new Error(`Stored File resolution identity mismatch at prompt node ${nodeOrdinal}`);
      }
      return;
    }
    if (node.kind === "image" && resolution.kind === "image") {
      if (resolution.attachmentId !== node.attachmentId) {
        throw new Error(`Stored Image resolution identity mismatch at prompt node ${nodeOrdinal}`);
      }
      const attachment = attachments.get(node.attachmentId);
      if (
        attachment?.kind !== "image" ||
        attachment.blobRef !== resolution.blob.blobRef ||
        attachment.mediaType !== resolution.mediaType ||
        attachment.byteLength !== resolution.blob.byteLength
      ) {
        throw new Error(`Stored Image attachment mismatch at prompt node ${nodeOrdinal}`);
      }
    }
  });
}
