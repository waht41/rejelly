import fs from "node:fs/promises";
import path from "node:path";
import type { ContentPart, Message } from "@rejelly/core";
import type { ConversationAgentProps, UserAttachment, UserImageAttachment } from "../AgentShared";
import { getWorkspaceFsPolicy, toGitignorePath } from "../fs-policy/workspace-fs-policy";

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

function fenceFor(content: string): string {
  const longest =
    content.match(/`{3,}/g)?.reduce((max, tick) => Math.max(max, tick.length), 2) ?? 2;
  return "`".repeat(longest + 1);
}

export async function buildAttachmentActionSummary(
  attachments: UserAttachment[] = [],
): Promise<string[]> {
  const policy = getWorkspaceFsPolicy();
  const paths = uniqueAttachments(attachments);
  const actions: string[] = [];
  let imageIndex = 0;
  for (const attachedPath of paths) {
    if (attachedPath.type === "image") {
      imageIndex += 1;
      actions.push(`attach [Image #${imageIndex}]`);
      continue;
    }
    const resolved = policy.tryResolve(attachedPath.path);
    if (!resolved.ok) {
      actions.push(`attach ${attachedPath.path} failed`);
      continue;
    }
    try {
      const stat = await policy.stat(resolved.rel);
      const displayPath = toGitignorePath(resolved.rel);
      actions.push(`${stat.isDirectory() ? "list" : "read"} ${displayPath}`);
    } catch {
      actions.push(`attach ${attachedPath.path} failed`);
    }
  }
  return actions;
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
      blocks.push(`### @${attachedPath.path}\nError: ${resolved.error}`);
      continue;
    }
    try {
      const stat = await policy.stat(resolved.rel);
      const displayPath = toGitignorePath(resolved.rel);
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
          `### @${displayPath}\nlist ${displayPath}\n\`\`\`text\n${visible.join("\n")}${truncated}\n\`\`\``,
        );
        continue;
      }
      if (stat.size > MAX_ATTACHMENT_BYTES_PER_FILE) {
        blocks.push(
          `### @${displayPath}\nread ${displayPath}\nError: File is larger than ${MAX_ATTACHMENT_BYTES_PER_FILE / 1024} KB and was not attached inline.`,
        );
        continue;
      }
      if (totalBytes + stat.size > MAX_ATTACHMENT_BYTES_TOTAL) {
        blocks.push(
          `### @${displayPath}\nread ${displayPath}\nError: Attachment budget exceeded (${MAX_ATTACHMENT_BYTES_TOTAL / 1024} KB total).`,
        );
        continue;
      }
      totalBytes += stat.size;
      const content = await policy.readFile(resolved.rel);
      const fence = fenceFor(content);
      blocks.push(`### @${displayPath}\nread ${displayPath}\n${fence}\n${content}\n${fence}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      blocks.push(`### @${attachedPath.path}\nError: Failed to read attached path: ${msg}`);
    }
  }

  return `\n\n## Attached paths for this turn\n${blocks.join("\n\n")}`;
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

async function buildImageParts(attachments: UserAttachment[] = []): Promise<ContentPart[]> {
  const policy = getWorkspaceFsPolicy();
  const images = uniqueAttachments(attachments).filter(
    (attachment): attachment is UserImageAttachment => attachment.type === "image",
  );
  const parts: ContentPart[] = [];
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
    parts.push({
      type: "image",
      image: {
        url: `data:${mimeType};base64,${bytes.toString("base64")}`,
        detail: image.detail ?? "auto",
      },
    });
  }
  return parts;
}

export async function buildUserMessageContent(props: {
  userInput: string;
  attachments?: UserAttachment[];
}): Promise<Message["content"]> {
  const attachmentContext = await buildAttachmentContext(props.attachments);
  const imageParts = await buildImageParts(props.attachments);
  const text = `${props.userInput}${attachmentContext}`;
  return imageParts.length > 0 ? [{ type: "text", text }, ...imageParts] : text;
}

export async function buildConversationMessages(props: ConversationAgentProps): Promise<Message[]> {
  const content = await buildUserMessageContent(props);
  return [...(props.history ?? []), { role: "user", content }];
}
