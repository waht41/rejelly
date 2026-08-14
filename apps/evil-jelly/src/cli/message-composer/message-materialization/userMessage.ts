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
    };
  }
}

interface MaterializedImage {
  part: ContentPart;
  dimensions: { width: number; height: number } | null;
  display: UserInputAttachmentDisplay;
}

async function materializeImage(
  attachment: PromptImageAttachment,
  imageIndex: number,
): Promise<MaterializedImage> {
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
    dimensions,
    display: {
      type: "image",
      label: `[Image #${imageIndex}]`,
      action: "attach",
      locator: fileLocatorFromUserPath(policy.getRoot(), attachment.path),
    },
  };
}

export interface UserMessageMaterializationOptions {
  skillContext?: (qualifiedName: string) => string;
}

/** Compile PromptInput once, in document order, without parsing any display projection. */
export async function buildUserMessage(
  input: PromptInput,
  options: UserMessageMaterializationOptions = {},
): Promise<Message> {
  assertValidPromptInput(input);
  const attachments = new Map(input.attachments.map((attachment) => [attachment.id, attachment]));
  const contentParts: ContentPart[] = [];
  const attachmentDisplays: UserInputAttachmentDisplay[] = [];
  const imageDimensions: Array<{ width: number; height: number } | null> = [];
  const fileBudget: FileMaterializationBudget = { totalBytes: 0 };
  let modelText = "";
  let displayText = "";
  let imageIndex = 0;

  const flushModelText = () => {
    if (!modelText) return;
    contentParts.push({ type: "text", text: modelText });
    modelText = "";
  };

  for (const node of input.document) {
    if (node.type === "text" || node.kind === "paste") {
      modelText += node.text;
      displayText += node.text;
      continue;
    }
    if (node.kind === "skill") {
      const marker = `$${node.qualifiedName}`;
      const context = options.skillContext?.(node.qualifiedName) ?? "";
      modelText += context ? `${marker}\n\n${context}` : marker;
      displayText += marker;
      continue;
    }

    const attachment = attachments.get(node.attachmentId)!;
    if (node.kind === "file" && attachment.kind === "file") {
      const marker = `@${attachment.path}`;
      const materialized = await materializeFile(attachment, fileBudget);
      modelText += `${marker}\n\n${materialized.context}`;
      displayText += marker;
      attachmentDisplays.push(materialized.display);
      continue;
    }
    if (node.kind === "image" && attachment.kind === "image") {
      imageIndex += 1;
      const marker = `[Image #${imageIndex}]`;
      const materialized = await materializeImage(attachment, imageIndex);
      modelText += marker;
      displayText += marker;
      flushModelText();
      contentParts.push(materialized.part);
      imageDimensions.push(materialized.dimensions);
      attachmentDisplays.push(materialized.display);
    }
  }

  const hasImages = imageDimensions.length > 0;
  if (hasImages) flushModelText();
  const content: Message["content"] = hasImages ? contentParts : modelText;
  const display = { text: displayText, attachments: attachmentDisplays } satisfies UserInputDisplay;
  return {
    role: "user",
    content,
    extra: {
      rejelly: createUserInputMetadata(display, imageDimensions),
    },
  };
}
