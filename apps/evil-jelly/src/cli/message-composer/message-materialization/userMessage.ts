import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ContentPart, Message } from "@rejelly/core";
import { readImageDimensions } from "../../../shared/foundation/media/imageDimensions";
import {
  fileLocatorAttributes,
  fileLocatorFromResolved,
  fileLocatorFromUserPath,
} from "../../../shared/fs-policy/file-locator";
import { getWorkspaceFsPolicy } from "../../../shared/fs-policy/workspace-fs-policy";
import {
  createUserInputMetadata,
  type UserInputAttachmentDisplay,
  type UserInputDisplay,
} from "../../../shared/model/message/userInputMetadata";
import {
  assertValidPromptInput,
  type PromptFileAttachment,
  type PromptImageAttachment,
  type PromptInput,
} from "../../../shared/model/prompt/promptInput";
import { renderPseudoXmlElement } from "../../../shared/model/prompt/pseudoXml";
import type {
  TokenResolutionV1,
  UserInputMaterializationV1,
} from "../../../shared/model/prompt/userInputMaterialization";

const MAX_ATTACHMENT_BYTES_PER_FILE = 80 * 1024;
const MAX_ATTACHMENT_BYTES_TOTAL = 100 * 1024;
const MAX_ATTACHMENT_DIR_ENTRIES = 80;
const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

interface FileMaterializationBudget {
  totalBytes: number;
}

interface MaterializedFile {
  context: string;
  display: UserInputAttachmentDisplay;
  status: "resolved" | "error";
}

async function materializeFile(
  attachment: PromptFileAttachment,
  budget: FileMaterializationBudget,
): Promise<MaterializedFile> {
  const policy = getWorkspaceFsPolicy();
  const resolved = policy.tryResolve(attachment.path);
  if (!resolved.ok) {
    return {
      context: renderPseudoXmlElement("attached_path", `Error: ${resolved.error}`, {
        path: attachment.path,
        status: "error",
      }),
      display: {
        type: "file",
        label: attachment.path,
        action: "attach",
        status: "error",
      },
      status: "error",
    };
  }

  const locator = fileLocatorFromResolved(resolved);
  const locatorAttributes = fileLocatorAttributes(locator);
  try {
    const stat = await policy.stat(resolved.rel);
    if (stat.isDirectory()) {
      const entries = await policy.readdir(resolved.rel, { withFileTypes: true });
      const visible = entries.slice(0, MAX_ATTACHMENT_DIR_ENTRIES).map((entry) => {
        const kind = entry.isDirectory() ? "dir" : "file";
        return `[${kind}] ${entry.name}${entry.isDirectory() ? "/" : ""}`;
      });
      const truncated =
        entries.length > MAX_ATTACHMENT_DIR_ENTRIES
          ? `\n... and ${entries.length - MAX_ATTACHMENT_DIR_ENTRIES} more`
          : "";
      return {
        context: renderPseudoXmlElement("attached_directory", `${visible.join("\n")}${truncated}`, {
          ...locatorAttributes,
          action: "list",
        }),
        display: { type: "file", label: locator.path, action: "list", locator },
        status: "resolved",
      };
    }

    if (stat.size > MAX_ATTACHMENT_BYTES_PER_FILE) {
      return {
        context: renderPseudoXmlElement(
          "attached_file",
          `Error: File is larger than ${MAX_ATTACHMENT_BYTES_PER_FILE / 1024} KB and was not attached inline.`,
          { ...locatorAttributes, action: "read", status: "error" },
        ),
        display: {
          type: "file",
          label: locator.path,
          action: "read",
          status: "error",
          locator,
        },
        status: "error",
      };
    }
    if (budget.totalBytes + stat.size > MAX_ATTACHMENT_BYTES_TOTAL) {
      return {
        context: renderPseudoXmlElement(
          "attached_file",
          `Error: Attachment budget exceeded (${MAX_ATTACHMENT_BYTES_TOTAL / 1024} KB total).`,
          { ...locatorAttributes, action: "read", status: "error" },
        ),
        display: {
          type: "file",
          label: locator.path,
          action: "read",
          status: "error",
          locator,
        },
        status: "error",
      };
    }

    budget.totalBytes += stat.size;
    const content = await policy.readFile(resolved.rel);
    return {
      context: renderPseudoXmlElement("attached_file", content, {
        ...locatorAttributes,
        action: "read",
      }),
      display: { type: "file", label: locator.path, action: "read", locator },
      status: "resolved",
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      context: renderPseudoXmlElement(
        "attached_path",
        `Error: Failed to read attached path: ${message}`,
        { ...locatorAttributes, status: "error" },
      ),
      display: {
        type: "file",
        label: locator.path,
        action: "attach",
        status: "error",
        locator,
      },
      status: "error",
    };
  }
}

interface MaterializedImage {
  part: ContentPart;
  sha256: string;
  byteLength: number;
  dimensions: { width: number; height: number } | null;
  display: Omit<UserInputAttachmentDisplay, "label">;
}

async function materializeImage(attachment: PromptImageAttachment): Promise<MaterializedImage> {
  const policy = getWorkspaceFsPolicy();
  const absPath = path.isAbsolute(attachment.path)
    ? attachment.path
    : path.resolve(policy.getRoot(), attachment.path);
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) {
    throw new Error(`Image attachment is not a file: ${attachment.path}`);
  }
  if (stat.size > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new Error(
      `Image attachment is larger than ${MAX_IMAGE_ATTACHMENT_BYTES / 1024 / 1024} MB: ${attachment.path}`,
    );
  }
  const bytes = await fs.readFile(absPath);
  const dimensions = readImageDimensions(bytes) ?? null;
  return {
    part: {
      type: "image",
      image: {
        url: `data:${attachment.mimeType};base64,${bytes.toString("base64")}`,
        detail: attachment.detail ?? "auto",
      },
    },
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    dimensions,
    display: {
      type: "image",
      action: "attach",
      locator: fileLocatorFromUserPath(policy.getRoot(), attachment.path),
    },
  };
}

export interface UserMessageMaterializationOptions {
  /** Resolved Skill instructions, appended after the intact user-authored document. */
  skillContext?: string;
  skillResolution?: (qualifiedName: string) => {
    status: "resolved" | "unavailable";
    context?: string;
  };
}

/** Compile PromptInput once, in document order, without parsing any display projection. */
export async function materializeUserInput(
  input: PromptInput,
  options: UserMessageMaterializationOptions = {},
): Promise<UserInputMaterializationV1> {
  assertValidPromptInput(input);
  const attachments = new Map(input.attachments.map((attachment) => [attachment.id, attachment]));
  const contentParts: ContentPart[] = [];
  const attachmentDisplays: UserInputAttachmentDisplay[] = [];
  const imageDimensions: Array<{ width: number; height: number } | null> = [];
  const resolutions: TokenResolutionV1[] = [];
  const fileBudget: FileMaterializationBudget = { totalBytes: 0 };
  const fileCache = new Map<string, Promise<MaterializedFile>>();
  const imageCache = new Map<string, Promise<MaterializedImage>>();
  let modelText = "";
  let displayText = "";
  let imageIndex = 0;

  const flushModelText = () => {
    if (!modelText) return;
    contentParts.push({ type: "text", text: modelText });
    modelText = "";
  };

  for (const [nodeOrdinal, node] of input.document.entries()) {
    if (node.type === "text" || node.kind === "paste") {
      modelText += node.text;
      displayText += node.text;
      continue;
    }
    if (node.kind === "skill") {
      const marker = `$${node.qualifiedName}`;
      modelText += marker;
      displayText += marker;
      const resolution = options.skillResolution?.(node.qualifiedName) ?? {
        status: "unavailable" as const,
      };
      resolutions.push({
        version: 1,
        nodeOrdinal,
        kind: "skill",
        qualifiedName: node.qualifiedName,
        ...resolution,
      });
      continue;
    }

    const attachment = attachments.get(node.attachmentId)!;
    if (node.kind === "file" && attachment.kind === "file") {
      const marker = `@${attachment.path}`;
      let pending = fileCache.get(attachment.id);
      if (!pending) {
        pending = materializeFile(attachment, fileBudget);
        fileCache.set(attachment.id, pending);
      }
      const materialized = await pending;
      modelText += `${marker}\n\n${materialized.context}`;
      displayText += marker;
      attachmentDisplays.push(materialized.display);
      resolutions.push({
        version: 1,
        nodeOrdinal,
        kind: "file",
        attachmentId: node.attachmentId,
        status: materialized.status,
        context: materialized.context,
      });
      continue;
    }
    if (node.kind === "image" && attachment.kind === "image") {
      imageIndex += 1;
      const marker = `[Image #${imageIndex}]`;
      let pending = imageCache.get(attachment.id);
      if (!pending) {
        pending = materializeImage(attachment);
        imageCache.set(attachment.id, pending);
      }
      const materialized = await pending;
      modelText += marker;
      displayText += marker;
      flushModelText();
      contentParts.push(materialized.part);
      imageDimensions.push(materialized.dimensions);
      attachmentDisplays.push({ ...materialized.display, label: marker });
      resolutions.push({
        version: 1,
        nodeOrdinal,
        kind: "image",
        attachmentId: node.attachmentId,
        status: "resolved",
        mediaType: attachment.mimeType,
        sha256: materialized.sha256,
        byteLength: materialized.byteLength,
        dimensions: materialized.dimensions,
        detail: attachment.detail ?? "auto",
      });
    }
  }

  if (options.skillContext) {
    modelText += `${modelText ? "\n\n" : ""}${options.skillContext}`;
  }

  const hasImages = imageDimensions.length > 0;
  if (hasImages) flushModelText();
  const content: Message["content"] = hasImages ? contentParts : modelText;
  const display = { text: displayText, attachments: attachmentDisplays } satisfies UserInputDisplay;
  return {
    version: 1,
    message: {
      role: "user",
      content,
      extra: {
        rejelly: createUserInputMetadata(display, imageDimensions),
      },
    },
    display,
    resolutions,
  };
}
