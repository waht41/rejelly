import fs from "node:fs/promises";
import path from "node:path";
import type { ContentPart, Message } from "@rejelly/core";
import { z } from "zod";
import type { ConversationAgentProps, UserAttachment, UserImageAttachment } from "../AgentShared";
import { getWorkspaceFsPolicy } from "../fs-policy/workspace-fs-policy";
import { toPosixPath } from "../lib/path";
import { renderPseudoXmlElement } from "../lib/pseudoXml";

const MAX_ATTACHMENT_BYTES_PER_FILE = 80 * 1024;
const MAX_ATTACHMENT_BYTES_TOTAL = 100 * 1024;
const MAX_ATTACHMENT_DIR_ENTRIES = 80;
const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const USER_INPUT_MESSAGE_KIND = "user_input";

const userInputAttachmentDisplaySchema = z.object({
  type: z.enum(["file", "image"]),
  label: z.string(),
  action: z.enum(["read", "list", "attach"]),
  status: z.literal("error").optional(),
});

const userInputDisplaySchema = z.object({
  text: z.string(),
  attachments: z.array(userInputAttachmentDisplaySchema),
});

const userInputMetadataSchema = z.object({
  kind: z.literal(USER_INPUT_MESSAGE_KIND),
  display: userInputDisplaySchema,
});

export type UserInputAttachmentDisplay = z.infer<typeof userInputAttachmentDisplaySchema>;
export type UserInputDisplay = z.infer<typeof userInputDisplaySchema>;

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
      displays.push({ type: "image", label: `[Image #${imageIndex}]`, action: "attach" });
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
    try {
      const stat = await policy.stat(resolved.rel);
      const displayPath = toPosixPath(resolved.displayPath);
      displays.push({
        type: "file",
        label: displayPath,
        action: stat.isDirectory() ? "list" : "read",
      });
    } catch {
      displays.push({
        type: "file",
        label: attachedPath.path,
        action: "attach",
        status: "error",
      });
    }
  }
  return displays;
}

function formatAttachmentDisplay(display: UserInputAttachmentDisplay): string {
  return `${display.action} ${display.label}${display.status === "error" ? " failed" : ""}`;
}

export async function buildAttachmentActionSummary(
  attachments: UserAttachment[] = [],
): Promise<string[]> {
  return (await buildAttachmentDisplays(attachments)).map(formatAttachmentDisplay);
}

export function formatUserInputDisplay(display: UserInputDisplay): string {
  if (display.attachments.length === 0) {
    return display.text;
  }
  return `${display.text}\n${display.attachments
    .map((attachment) => `  -> ${formatAttachmentDisplay(attachment)}`)
    .join("\n")}`;
}

export function getUserInputDisplay(message: Message): UserInputDisplay | undefined {
  const metadata = userInputMetadataSchema.safeParse(message.extra?.rejelly);
  return metadata.success ? metadata.data.display : undefined;
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
    try {
      const stat = await policy.stat(resolved.rel);
      const displayPath = toPosixPath(resolved.displayPath);
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
            path: displayPath,
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
            { path: displayPath, action: "read", status: "error" },
          ),
        );
        continue;
      }
      if (totalBytes + stat.size > MAX_ATTACHMENT_BYTES_TOTAL) {
        blocks.push(
          renderPseudoXmlElement(
            "attached_file",
            `Error: Attachment budget exceeded (${MAX_ATTACHMENT_BYTES_TOTAL / 1024} KB total).`,
            { path: displayPath, action: "read", status: "error" },
          ),
        );
        continue;
      }
      totalBytes += stat.size;
      const content = await policy.readFile(resolved.rel);
      blocks.push(
        renderPseudoXmlElement("attached_file", content, {
          path: displayPath,
          action: "read",
        }),
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      blocks.push(
        renderPseudoXmlElement("attached_path", `Error: Failed to read attached path: ${msg}`, {
          path: attachedPath.path,
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

export async function buildUserMessage(props: {
  userInput: string;
  attachments?: UserAttachment[];
}): Promise<Message> {
  const [content, attachments] = await Promise.all([
    buildUserMessageContent(props),
    buildAttachmentDisplays(props.attachments),
  ]);
  return {
    role: "user",
    content,
    extra: {
      rejelly: {
        kind: USER_INPUT_MESSAGE_KIND,
        display: {
          text: props.userInput,
          attachments,
        } satisfies UserInputDisplay,
      },
    },
  };
}

export async function buildConversationMessages(props: ConversationAgentProps): Promise<Message[]> {
  return [...(props.history ?? []), await buildUserMessage(props)];
}
