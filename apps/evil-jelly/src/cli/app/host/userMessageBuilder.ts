import fs from "node:fs/promises";
import path from "node:path";
import type { ContentPart, Message } from "@rejelly/core";
import type { UserAttachment, UserImageAttachment } from "../../../shared/AgentShared";
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
import { renderPseudoXmlElement } from "../../../shared/model/prompt/pseudoXml";

const MAX_ATTACHMENT_BYTES_PER_FILE = 80 * 1024;
const MAX_ATTACHMENT_BYTES_TOTAL = 100 * 1024;
const MAX_ATTACHMENT_DIR_ENTRIES = 80;
const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function uniqueAttachments(attachments: UserAttachment[] = []): UserAttachment[] {
  const seen = new Set<string>();
  const out: UserAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.type !== "file" && attachment.type !== "image") {
      continue;
    }
    const path = attachment.path.trim();
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    if (attachment.type === "image") {
      out.push({
        type: "image",
        path,
        mimeType: attachment.mimeType,
        detail: attachment.detail,
      });
    } else {
      out.push({ type: "file", path });
    }
  }
  return out;
}

async function buildAttachmentDisplays(
  attachments: UserAttachment[] = [],
): Promise<UserInputAttachmentDisplay[]> {
  const policy = getWorkspaceFsPolicy();
  const paths = uniqueAttachments(attachments);
  const displays: UserInputAttachmentDisplay[] = [];
  let imageIndex = 0;
  for (const attachedPath of paths) {
    if (attachedPath.type === "image") {
      imageIndex += 1;
      displays.push({
        type: "image",
        label: `[Image #${imageIndex}]`,
        action: "attach",
        locator: fileLocatorFromUserPath(policy.getRoot(), attachedPath.path),
      });
      continue;
    }
    const resolved = policy.tryResolve(attachedPath.path);
    if (!resolved.ok) {
      displays.push({
        type: "file",
        label: attachedPath.path,
        action: "attach",
        status: "error",
      });
      continue;
    }
    const locator = fileLocatorFromResolved(resolved);
    try {
      const stat = await policy.stat(resolved.rel);
      displays.push({
        type: "file",
        label: locator.path,
        action: stat.isDirectory() ? "list" : "read",
        locator,
      });
    } catch {
      displays.push({
        type: "file",
        label: locator.path,
        action: "attach",
        status: "error",
        locator,
      });
    }
  }
  return displays;
}

async function buildAttachmentContext(attachments: UserAttachment[] = []): Promise<string> {
  const policy = getWorkspaceFsPolicy();
  const paths = uniqueAttachments(attachments).filter((attachment) => attachment.type === "file");
  if (paths.length === 0) {
    return "";
  }

  let totalBytes = 0;
  const blocks: string[] = [];
  for (const attachedPath of paths) {
    const resolved = policy.tryResolve(attachedPath.path);
    if (!resolved.ok) {
      blocks.push(
        renderPseudoXmlElement("attached_path", `Error: ${resolved.error}`, {
          path: attachedPath.path,
          status: "error",
        }),
      );
      continue;
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
        blocks.push(
          renderPseudoXmlElement("attached_directory", `${visible.join("\n")}${truncated}`, {
            ...locatorAttributes,
            action: "list",
          }),
        );
        continue;
      }
      if (stat.size > MAX_ATTACHMENT_BYTES_PER_FILE) {
        blocks.push(
          renderPseudoXmlElement(
            "attached_file",
            `Error: File is larger than ${MAX_ATTACHMENT_BYTES_PER_FILE / 1024} KB and was not attached inline.`,
            { ...locatorAttributes, action: "read", status: "error" },
          ),
        );
        continue;
      }
      if (totalBytes + stat.size > MAX_ATTACHMENT_BYTES_TOTAL) {
        blocks.push(
          renderPseudoXmlElement(
            "attached_file",
            `Error: Attachment budget exceeded (${MAX_ATTACHMENT_BYTES_TOTAL / 1024} KB total).`,
            { ...locatorAttributes, action: "read", status: "error" },
          ),
        );
        continue;
      }
      totalBytes += stat.size;
      const content = await policy.readFile(resolved.rel);
      blocks.push(
        renderPseudoXmlElement("attached_file", content, {
          ...locatorAttributes,
          action: "read",
        }),
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      blocks.push(
        renderPseudoXmlElement("attached_path", `Error: Failed to read attached path: ${msg}`, {
          ...locatorAttributes,
          status: "error",
        }),
      );
    }
  }

  return `\n\n${blocks.join("\n\n")}`;
}

function mimeTypeForImage(pathname: string, explicit?: UserImageAttachment["mimeType"]): string {
  if (explicit) {
    return explicit;
  }
  switch (path.extname(pathname).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

interface BuiltImageParts {
  parts: ContentPart[];
  dimensions: Array<{ width: number; height: number } | null>;
}

async function buildImageParts(attachments: UserAttachment[] = []): Promise<BuiltImageParts> {
  const policy = getWorkspaceFsPolicy();
  const images = uniqueAttachments(attachments).filter(
    (attachment): attachment is UserImageAttachment => attachment.type === "image",
  );
  const parts: ContentPart[] = [];
  const dimensions: BuiltImageParts["dimensions"] = [];
  for (const image of images) {
    const absPath = path.isAbsolute(image.path)
      ? image.path
      : path.resolve(policy.getRoot(), image.path);
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      throw new Error(`Image attachment is not a file: ${image.path}`);
    }
    if (stat.size > MAX_IMAGE_ATTACHMENT_BYTES) {
      throw new Error(
        `Image attachment is larger than ${MAX_IMAGE_ATTACHMENT_BYTES / 1024 / 1024} MB: ${image.path}`,
      );
    }
    const bytes = await fs.readFile(absPath);
    const mimeType = mimeTypeForImage(absPath, image.mimeType);
    const imageDimensions = readImageDimensions(bytes);
    parts.push({
      type: "image",
      image: {
        url: `data:${mimeType};base64,${bytes.toString("base64")}`,
        detail: image.detail ?? "auto",
      },
    });
    dimensions.push(imageDimensions ?? null);
  }
  return { parts, dimensions };
}

async function buildUserMessagePayload(props: {
  userInput: string;
  attachments?: UserAttachment[];
}): Promise<{ content: Message["content"]; imageDimensions: BuiltImageParts["dimensions"] }> {
  const [attachmentContext, images] = await Promise.all([
    buildAttachmentContext(props.attachments),
    buildImageParts(props.attachments),
  ]);
  const text = `${props.userInput}${attachmentContext}`;
  return {
    content: images.parts.length > 0 ? [{ type: "text", text }, ...images.parts] : text,
    imageDimensions: images.dimensions,
  };
}

export async function buildUserMessage(props: {
  userInput: string;
  attachments?: UserAttachment[];
}): Promise<Message> {
  const [payload, attachments] = await Promise.all([
    buildUserMessagePayload(props),
    buildAttachmentDisplays(props.attachments),
  ]);
  const display = {
    text: props.userInput,
    attachments,
  } satisfies UserInputDisplay;
  return {
    role: "user",
    content: payload.content,
    extra: {
      rejelly: createUserInputMetadata(display, payload.imageDimensions),
    },
  };
}
