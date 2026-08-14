import { isDeepStrictEqual } from "node:util";
import type { Message } from "@rejelly/core";
import {
  getUserInputDisplay,
  type UserInputDisplay,
  type UserInputImageDimensions,
} from "../message/userInputMetadata";
import {
  assertValidPromptInput,
  type PromptImageDetail,
  type PromptImageMimeType,
  type PromptInput,
  promptInputPlainText,
} from "./promptInput";

interface TokenResolutionBaseV1 {
  readonly version: 1;
  /** Zero-based ordinal in the canonical PromptDocument. */
  readonly nodeOrdinal: number;
}

export type TokenResolutionV1 =
  | (TokenResolutionBaseV1 & {
      readonly kind: "skill";
      readonly qualifiedName: string;
      readonly status: "resolved" | "unavailable";
      /** Frozen rendered Skill body. The combined envelope is already frozen in message. */
      readonly context?: string;
    })
  | (TokenResolutionBaseV1 & {
      readonly kind: "file";
      readonly attachmentId: string;
      readonly status: "resolved" | "error";
      /** Exact bounded context emitted into the model message. */
      readonly context: string;
    })
  | (TokenResolutionBaseV1 & {
      readonly kind: "image";
      readonly attachmentId: string;
      readonly status: "resolved";
      readonly mediaType: PromptImageMimeType;
      /** Digest of the exact bytes embedded in message; stable across blob preparation. */
      readonly sha256: string;
      readonly byteLength: number;
      readonly dimensions: UserInputImageDimensions | null;
      readonly detail: PromptImageDetail;
    });

/** One immutable compilation result shared by model dispatch, display, and Session storage. */
export interface UserInputMaterializationV1 {
  readonly version: 1;
  readonly message: Message;
  readonly display: UserInputDisplay;
  readonly resolutions: readonly TokenResolutionV1[];
}

/** Reject a materialization that does not describe exactly the supplied semantic document. */
export function assertMatchingUserInputMaterialization(
  input: PromptInput,
  materialization: UserInputMaterializationV1,
): void {
  assertValidPromptInput(input);
  if (materialization.version !== 1 || materialization.message.role !== "user") {
    throw new Error("Invalid UserInputMaterializationV1 envelope");
  }
  if (materialization.display.text !== promptInputPlainText(input)) {
    throw new Error("Materialized display text does not match PromptInput document");
  }
  if (!isDeepStrictEqual(getUserInputDisplay(materialization.message), materialization.display)) {
    throw new Error("Materialized Message display metadata does not match materialization.display");
  }

  const byOrdinal = new Map(materialization.resolutions.map((item) => [item.nodeOrdinal, item]));
  if (byOrdinal.size !== materialization.resolutions.length) {
    throw new Error("Materialization contains duplicate node resolutions");
  }
  input.document.forEach((node, nodeOrdinal) => {
    const needsResolution =
      node.type === "token" &&
      (node.kind === "skill" || node.kind === "file" || node.kind === "image");
    const resolution = byOrdinal.get(nodeOrdinal);
    if (!needsResolution) {
      if (resolution) throw new Error(`Unexpected resolution for prompt node ${nodeOrdinal}`);
      return;
    }
    if (!resolution || resolution.kind !== node.kind) {
      throw new Error(`Missing ${node.kind} resolution for prompt node ${nodeOrdinal}`);
    }
    if (
      node.kind === "skill" &&
      resolution.kind === "skill" &&
      resolution.qualifiedName !== node.qualifiedName
    ) {
      throw new Error(`Skill resolution identity mismatch at prompt node ${nodeOrdinal}`);
    }
    if (
      (node.kind === "file" || node.kind === "image") &&
      (resolution.kind === "file" || resolution.kind === "image") &&
      resolution.attachmentId !== node.attachmentId
    ) {
      throw new Error(`Attachment resolution identity mismatch at prompt node ${nodeOrdinal}`);
    }
  });
}
