import type { ContentPart, Message } from "@rejelly/core";
import type { FileLocator } from "../../fs-policy/file-locator";
import type { SessionBlobMetadata } from "../../session/blobContract";
import { renderPseudoXmlElement, renderPseudoXmlEmptyElement } from "./pseudoXml";

export interface UserInputAttachmentDisplay {
  readonly type: "file" | "image";
  readonly label: string;
  readonly action: "read" | "list" | "attach";
  readonly status?: "error";
  readonly locator?: FileLocator;
}

export interface UserInputDisplay {
  readonly text: string;
  readonly attachments: readonly UserInputAttachmentDisplay[];
}

export type ResolvedUserInputNodeV1 =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "paste"; readonly text: string }
  | {
      readonly kind: "skill";
      readonly qualifiedName: string;
      readonly status: "resolved" | "unavailable";
      readonly context?: string;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly action: "read" | "list" | "attach";
      readonly status: "resolved" | "error";
      readonly context: string;
      readonly locator?: FileLocator;
    }
  | {
      readonly kind: "image";
      /** Transaction-local identity used only to avoid persisting the same bytes more than once. */
      readonly sourceId: string;
      readonly bytes: Uint8Array;
      readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      readonly detail: "auto" | "low" | "high";
    }
  | {
      readonly kind: "mcp";
      readonly serverId: string;
      readonly status: "selected" | "unavailable" | "disabled" | "untrusted";
      readonly configFingerprint?: string;
    };

/** Transient resolver output. It is consumed by commit and never stored or used as a projection source. */
export interface ResolvedUserInputV1 {
  readonly version: 1;
  readonly nodes: readonly ResolvedUserInputNodeV1[];
}

export type FrozenUserInputNodeV1 =
  | Exclude<ResolvedUserInputNodeV1, { kind: "image" }>
  | {
      readonly kind: "image";
      readonly blob: SessionBlobMetadata;
      readonly detail: "auto" | "low" | "high";
    };

export interface FrozenResolvedUserInputV1 {
  readonly version: 1;
  readonly kind: "resolved";
  readonly nodes: readonly FrozenUserInputNodeV1[];
}

/** Explicit V2 compatibility boundary; new V3 inputs are always `resolved`. */
export interface FrozenLegacyUserInputV1 {
  readonly version: 1;
  readonly kind: "legacy";
  readonly display: UserInputDisplay;
  readonly message: Message;
  readonly imageBlobs: Readonly<Record<string, SessionBlobMetadata>>;
}

/** The sole post-submit user-input fact. Every model/display/session view is a projection of this. */
export type FrozenUserInputV1 = FrozenResolvedUserInputV1 | FrozenLegacyUserInputV1;

function resolvedSkillContext(input: FrozenResolvedUserInputV1): string {
  const seen = new Set<string>();
  const contexts: string[] = [];
  for (const node of input.nodes) {
    if (
      node.kind !== "skill" ||
      node.status !== "resolved" ||
      node.context === undefined ||
      seen.has(node.qualifiedName)
    ) {
      continue;
    }
    seen.add(node.qualifiedName);
    contexts.push(node.context);
  }
  return contexts.length > 0
    ? renderPseudoXmlElement("explicit_skills", contexts.join("\n"), {
        count: String(contexts.length),
      })
    : "";
}

export function projectFrozenUserInputMessage(input: FrozenUserInputV1): Message {
  if (input.kind === "legacy") return input.message;

  const contentParts: ContentPart[] = [];
  let modelText = "";
  let imageIndex = 0;
  const flushText = () => {
    if (!modelText) return;
    contentParts.push({ type: "text", text: modelText });
    modelText = "";
  };

  for (const node of input.nodes) {
    switch (node.kind) {
      case "text":
      case "paste":
        modelText += node.text;
        break;
      case "skill":
        modelText += `$${node.qualifiedName}`;
        break;
      case "file":
        modelText += `@${node.path}\n\n${node.context}`;
        break;
      case "image":
        imageIndex += 1;
        modelText += `[Image #${imageIndex}]`;
        flushText();
        contentParts.push({
          type: "image",
          image: { url: node.blob.blobRef, detail: node.detail },
        });
        break;
      case "mcp":
        modelText += renderPseudoXmlEmptyElement("selected_mcp", {
          server: node.serverId,
          status: node.status,
        });
        break;
    }
  }

  const skillContext = resolvedSkillContext(input);
  if (skillContext) modelText += `${modelText ? "\n\n" : ""}${skillContext}`;
  if (imageIndex > 0) flushText();
  return { role: "user", content: imageIndex > 0 ? contentParts : modelText };
}

export function projectFrozenUserInputDisplay(input: FrozenUserInputV1): UserInputDisplay {
  if (input.kind === "legacy") {
    return {
      text: input.display.text,
      attachments: input.display.attachments.map((attachment) => ({ ...attachment })),
    };
  }
  let text = "";
  let imageIndex = 0;
  const attachments: UserInputAttachmentDisplay[] = [];
  for (const node of input.nodes) {
    switch (node.kind) {
      case "text":
      case "paste":
        text += node.text;
        break;
      case "skill":
        text += `$${node.qualifiedName}`;
        break;
      case "file":
        text += `@${node.path}`;
        attachments.push({
          type: "file",
          label: node.locator?.path ?? node.path,
          action: node.action,
          ...(node.status === "error" ? { status: "error" as const } : {}),
          ...(node.locator ? { locator: node.locator } : {}),
        });
        break;
      case "image": {
        imageIndex += 1;
        const label = `[Image #${imageIndex}]`;
        text += label;
        attachments.push({ type: "image", label, action: "attach" });
        break;
      }
      case "mcp":
        text += `$mcp:${node.serverId}`;
        break;
    }
  }
  return { text, attachments };
}

export function projectFrozenUserInputPlainText(input: FrozenUserInputV1): string {
  return projectFrozenUserInputDisplay(input).text;
}

/** Set projection used to authorize this turn; document order never changes selection semantics. */
export function frozenUserInputMcpServerIds(input: FrozenUserInputV1): readonly string[] {
  if (input.kind === "legacy") return [];
  return Object.freeze(
    [
      ...new Set(input.nodes.flatMap((node) => (node.kind === "mcp" ? [node.serverId] : []))),
    ].sort(),
  );
}

export function frozenUserInputImageBlobs(
  input: FrozenUserInputV1,
): Record<string, SessionBlobMetadata> {
  if (input.kind === "legacy") return { ...input.imageBlobs };
  return Object.fromEntries(
    input.nodes.flatMap((node) =>
      node.kind === "image" ? [[node.blob.blobRef, node.blob] as const] : [],
    ),
  );
}

export function frozenUserInputImageDimensions(
  input: FrozenUserInputV1,
): Array<{ width: number; height: number } | undefined> {
  if (input.kind === "resolved") {
    return input.nodes.flatMap((node) =>
      node.kind === "image"
        ? [
            node.blob.width && node.blob.height
              ? { width: node.blob.width, height: node.blob.height }
              : undefined,
          ]
        : [],
    );
  }
  if (!Array.isArray(input.message.content)) return [];
  return input.message.content.flatMap((part) => {
    if (part.type !== "image") return [];
    const blob = input.imageBlobs[part.image.url];
    return [blob?.width && blob.height ? { width: blob.width, height: blob.height } : undefined];
  });
}

const frozenInputOrigin = new WeakMap<Message, FrozenUserInputV1>();

/** Associate a disposable Message projection with its canonical input record. */
export function registerFrozenUserInputOrigin<T extends Message>(
  message: T,
  input: FrozenUserInputV1,
): T {
  frozenInputOrigin.set(message, input);
  return message;
}

export function getFrozenUserInputOrigin(message: Message): FrozenUserInputV1 | undefined {
  return frozenInputOrigin.get(message);
}

export function copyFrozenUserInputOrigin<T extends Message>(source: Message, target: T): T {
  const input = frozenInputOrigin.get(source);
  if (input) frozenInputOrigin.set(target, input);
  return target;
}
