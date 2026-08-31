import fs from "node:fs/promises";
import path from "node:path";
import {
  fileLocatorAttributes,
  fileLocatorFromResolved,
} from "../../../shared/fs-policy/file-locator";
import { getWorkspaceFiles } from "../../../shared/fs-policy/workspace-files";
import { validateMcpServerId } from "../../../shared/model/mcp/serverIdentity";
import type {
  ResolvedUserInputNodeV1,
  ResolvedUserInputV1,
} from "../../../shared/model/prompt/frozenUserInput";
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
  action: "read" | "list" | "attach";
  status: "resolved" | "error";
  locator?: ReturnType<typeof fileLocatorFromResolved>;
}

async function materializeFile(
  attachment: PromptFileAttachment,
  budget: FileMaterializationBudget,
): Promise<MaterializedFile> {
  const policy = getWorkspaceFiles();
  // An @-attachment names one exact path, so files use direct-read semantics. Directories still
  // require discovery access below; ignored directories are allowed only as an explicit bounded
  // scope and their entries keep the scoped traversal filters.
  const resolved = policy.tryResolveWorkspacePath(attachment.path, { kind: "read" });
  if (!resolved.ok) {
    return {
      context: renderPseudoXmlElement("attached_path", `Error: ${resolved.error}`, {
        path: attachment.path,
        status: "error",
      }),
      action: "attach",
      status: "error",
    };
  }

  const locator = fileLocatorFromResolved(resolved);
  const locatorAttributes = fileLocatorAttributes(locator);
  try {
    const stat = await policy.statResolved(resolved);
    if (stat.isDirectory()) {
      const ignored = policy.isIgnoredByGitignore(resolved.rel, true);
      const discoverable = policy.tryResolveWorkspacePath(
        resolved.rel,
        ignored ? { kind: "scan", includeIgnored: true } : { kind: "scan" },
      );
      if (!discoverable.ok) {
        throw new Error(discoverable.error);
      }
      const scopeError = ignored ? policy.validateScopedDiscoveryRoot(discoverable) : undefined;
      if (scopeError) {
        throw new Error(scopeError);
      }
      const entries = (await policy.readdirResolved(discoverable, { withFileTypes: true })).filter(
        (entry) =>
          !(ignored
            ? policy.shouldSkipScopedResolvedEntry(discoverable, entry)
            : policy.shouldSkipResolvedEntry(discoverable, entry)),
      );
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
        action: "list",
        locator,
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
        action: "read",
        locator,
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
        action: "read",
        locator,
        status: "error",
      };
    }

    budget.totalBytes += stat.size;
    const content = await policy.readResolved(resolved);
    return {
      context: renderPseudoXmlElement("attached_file", content, {
        ...locatorAttributes,
        action: "read",
      }),
      action: "read",
      locator,
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
      action: "attach",
      locator,
      status: "error",
    };
  }
}

interface MaterializedImage {
  bytes: Uint8Array;
}

async function materializeImage(attachment: PromptImageAttachment): Promise<MaterializedImage> {
  const policy = getWorkspaceFiles();
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
  return { bytes };
}

export interface UserMessageMaterializationOptions {
  skillResolution?: (qualifiedName: string) => {
    status: "resolved" | "unavailable";
    context?: string;
    referenceName?: string;
  };
  mcpResolution?: (serverId: string) => {
    status: "selected" | "unavailable" | "disabled" | "untrusted";
    configFingerprint?: string;
    referenceName?: string;
  };
  memoryResolution?: (memoryId: string) =>
    | {
        status: "resolved";
        scope: "user" | "project";
        revision: number;
        title: string;
        summary: string;
        detail: string;
        referenceName?: string;
      }
    | { status: "unavailable" }
    | Promise<
        | {
            status: "resolved";
            scope: "user" | "project";
            revision: number;
            title: string;
            summary: string;
            detail: string;
            referenceName?: string;
          }
        | { status: "unavailable" }
      >;
}

/** Compile PromptInput once, in document order, without parsing any display projection. */
export async function materializeUserInput(
  input: PromptInput,
  options: UserMessageMaterializationOptions = {},
): Promise<ResolvedUserInputV1> {
  assertValidPromptInput(input);
  const attachments = new Map(input.attachments.map((attachment) => [attachment.id, attachment]));
  const nodes: ResolvedUserInputNodeV1[] = [];
  const fileBudget: FileMaterializationBudget = { totalBytes: 0 };
  const fileCache = new Map<string, Promise<MaterializedFile>>();
  const imageCache = new Map<string, Promise<MaterializedImage>>();
  const memoryCache = new Map<
    string,
    Promise<
      | {
          status: "resolved";
          scope: "user" | "project";
          revision: number;
          title: string;
          summary: string;
          detail: string;
          referenceName?: string;
        }
      | { status: "unavailable" }
    >
  >();

  for (const node of input.document) {
    if (node.type === "text") {
      nodes.push({ kind: "text", text: node.text });
      continue;
    }
    if (node.kind === "paste") {
      nodes.push({ kind: "paste", text: node.text });
      continue;
    }
    if (node.kind === "skill") {
      const resolution = options.skillResolution?.(node.qualifiedName) ?? {
        status: "unavailable" as const,
      };
      nodes.push({
        kind: "skill",
        qualifiedName: node.qualifiedName,
        ...resolution,
      });
      continue;
    }
    if (node.kind === "mcp") {
      const identity = validateMcpServerId(node.serverId);
      if (!identity.ok) throw new Error(identity.reason);
      const resolution = options.mcpResolution?.(node.serverId) ?? {
        status: "unavailable" as const,
      };
      nodes.push({ kind: "mcp", serverId: node.serverId, ...resolution });
      continue;
    }
    if (node.kind === "memory") {
      let pending = memoryCache.get(node.memoryId);
      if (!pending) {
        pending = Promise.resolve(
          options.memoryResolution?.(node.memoryId) ?? { status: "unavailable" as const },
        );
        memoryCache.set(node.memoryId, pending);
      }
      nodes.push({ kind: "memory", memoryId: node.memoryId, ...(await pending) });
      continue;
    }

    const attachment = attachments.get(node.attachmentId)!;
    if (node.kind === "file" && attachment.kind === "file") {
      let pending = fileCache.get(attachment.id);
      if (!pending) {
        pending = materializeFile(attachment, fileBudget);
        fileCache.set(attachment.id, pending);
      }
      const materialized = await pending;
      nodes.push({
        kind: "file",
        path: attachment.path,
        action: materialized.action,
        status: materialized.status,
        context: materialized.context,
        ...(materialized.locator ? { locator: materialized.locator } : {}),
      });
      continue;
    }
    if (node.kind === "image" && attachment.kind === "image") {
      let pending = imageCache.get(attachment.id);
      if (!pending) {
        pending = materializeImage(attachment);
        imageCache.set(attachment.id, pending);
      }
      const materialized = await pending;
      nodes.push({
        kind: "image",
        sourceId: attachment.id,
        bytes: materialized.bytes,
        mediaType: attachment.mimeType,
        detail: attachment.detail ?? "auto",
      });
    }
  }
  return { version: 1, nodes };
}
