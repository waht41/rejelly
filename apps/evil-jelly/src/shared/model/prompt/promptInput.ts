import {
  isPromptDocumentSemanticallyEmpty,
  normalizePromptDocument,
  type PromptDocument,
  type PromptNode,
  promptDocumentCommandText,
  textPromptDocument,
} from "./promptDocument";

export const PROMPT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export type PromptImageMimeType = (typeof PROMPT_IMAGE_MIME_TYPES)[number];
export type PromptImageDetail = "auto" | "low" | "high";

export interface PromptFileAttachment {
  readonly id: string;
  readonly kind: "file";
  readonly path: string;
}

export interface PromptImageAttachment {
  readonly id: string;
  readonly kind: "image";
  readonly path: string;
  readonly mimeType: PromptImageMimeType;
  readonly detail?: PromptImageDetail;
  /** Only composer-owned temporary files may be deleted by prompt lifecycle cleanup. */
  readonly ownership: "borrowed" | "composer_temp";
}

export type PromptAttachment = PromptFileAttachment | PromptImageAttachment;

export interface PromptInput {
  readonly document: PromptDocument;
  readonly attachments: readonly PromptAttachment[];
}

export class PromptInputContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptInputContractError";
  }
}

export function textPromptInput(text: string): PromptInput {
  return { document: textPromptDocument(text), attachments: [] };
}

export function normalizePromptInput(input: PromptInput): PromptInput {
  return { document: normalizePromptDocument(input.document), attachments: input.attachments };
}

/** Snapshot immutable prompt data when ownership crosses an async queue/store boundary. */
export function copyPromptInput(input: PromptInput): PromptInput {
  assertValidPromptInput(input);
  return {
    document: input.document.map((node) => ({ ...node })),
    attachments: input.attachments.map((attachment) => ({ ...attachment })),
  };
}

function uniqueAttachmentId(id: string, inputIndex: number, used: Set<string>): string {
  if (!used.has(id)) return id;
  let suffix = 1;
  let candidate = `${id}:${inputIndex}:${suffix}`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${id}:${inputIndex}:${suffix}`;
  }
  return candidate;
}

/** Concatenate rich inputs while preserving node order and repairing attachment-id collisions. */
export function concatenatePromptInputs(
  inputs: readonly PromptInput[],
  separator = "\n",
): PromptInput {
  const nodes: PromptNode[] = [];
  const attachments: PromptAttachment[] = [];
  const usedIds = new Set<string>();

  for (const [inputIndex, input] of inputs.entries()) {
    assertValidPromptInput(input);
    const remappedIds = new Map<string, string>();
    for (const attachment of input.attachments) {
      const id = uniqueAttachmentId(attachment.id, inputIndex, usedIds);
      usedIds.add(id);
      remappedIds.set(attachment.id, id);
      attachments.push({ ...attachment, id });
    }
    if (nodes.length > 0 && input.document.length > 0 && separator) {
      nodes.push({ type: "text", text: separator });
    }
    nodes.push(
      ...input.document.map((node): PromptNode => {
        if (node.type !== "token" || (node.kind !== "file" && node.kind !== "image")) {
          return { ...node };
        }
        return { ...node, attachmentId: remappedIds.get(node.attachmentId) ?? node.attachmentId };
      }),
    );
  }

  const merged = { document: normalizePromptDocument(nodes), attachments };
  assertValidPromptInput(merged);
  return merged;
}

export function isPromptInputSemanticallyEmpty(input: PromptInput): boolean {
  return isPromptDocumentSemanticallyEmpty(input.document);
}

export function promptInputCommandText(input: PromptInput): string | undefined {
  return promptDocumentCommandText(input.document);
}

function attachmentReferences(document: PromptDocument): Map<string, "file" | "image"> {
  const references = new Map<string, "file" | "image">();
  for (const node of document) {
    if (node.type !== "token" || (node.kind !== "file" && node.kind !== "image")) {
      continue;
    }
    const existing = references.get(node.attachmentId);
    if (existing && existing !== node.kind) {
      throw new PromptInputContractError(
        `Attachment ${node.attachmentId} is referenced as both ${existing} and ${node.kind}`,
      );
    }
    references.set(node.attachmentId, node.kind);
  }
  return references;
}

/** Assert identity, reference-kind, and no-orphan invariants at a cross-layer boundary. */
export function assertValidPromptInput(input: PromptInput): void {
  const references = attachmentReferences(input.document);
  const attachments = new Map<string, PromptAttachment>();

  for (const attachment of input.attachments) {
    if (!attachment.id.trim()) {
      throw new PromptInputContractError("Prompt attachment id must not be empty");
    }
    if (attachments.has(attachment.id)) {
      throw new PromptInputContractError(`Duplicate prompt attachment id: ${attachment.id}`);
    }
    if (!attachment.path.trim()) {
      throw new PromptInputContractError(`${attachment.kind} attachment path must not be empty`);
    }
    attachments.set(attachment.id, attachment);
  }

  for (const [attachmentId, kind] of references) {
    const attachment = attachments.get(attachmentId);
    if (!attachment) {
      throw new PromptInputContractError(`Missing ${kind} attachment: ${attachmentId}`);
    }
    if (attachment.kind !== kind) {
      throw new PromptInputContractError(
        `Prompt token expects ${kind} attachment ${attachmentId}, received ${attachment.kind}`,
      );
    }
  }

  for (const attachment of input.attachments) {
    if (!references.has(attachment.id)) {
      throw new PromptInputContractError(`Unreferenced prompt attachment: ${attachment.id}`);
    }
  }

  input.document.forEach((node, index) => {
    assertValidPromptNode(node);
    if (node.type === "text" && node.text.length === 0) {
      throw new PromptInputContractError("Prompt document must not contain empty text nodes");
    }
    if (node.type === "text" && input.document[index - 1]?.type === "text") {
      throw new PromptInputContractError("Prompt document must merge adjacent text nodes");
    }
  });
}

function assertValidPromptNode(node: PromptNode): void {
  if (node.type !== "token") {
    return;
  }
  if (node.kind === "skill" && !node.qualifiedName.trim()) {
    throw new PromptInputContractError("Skill qualifiedName must not be empty");
  }
  if (node.kind === "paste" && node.text.length === 0) {
    throw new PromptInputContractError("Paste token text must not be empty");
  }
  if ((node.kind === "file" || node.kind === "image") && !node.attachmentId.trim()) {
    throw new PromptInputContractError(`${node.kind} token attachmentId must not be empty`);
  }
}

function promptInputTextProjection(input: PromptInput): string {
  const attachments = new Map(input.attachments.map((attachment) => [attachment.id, attachment]));
  return input.document
    .map((node) => {
      if (node.type === "text") {
        return node.text;
      }
      switch (node.kind) {
        case "skill":
          return `$${node.qualifiedName}`;
        case "paste":
          return node.text;
        case "file": {
          const attachment = attachments.get(node.attachmentId);
          return attachment?.kind === "file" ? `@${attachment.path}` : "[File]";
        }
        case "image":
          return "[Image]";
        default:
          return assertNever(node);
      }
    })
    .join("");
}

function assertNever(value: never): never {
  throw new PromptInputContractError(`Unknown prompt node: ${JSON.stringify(value)}`);
}

/** Lossy, readable fallback for titles, logs, and hosts without rich prompt support. */
export function promptInputPlainText(input: PromptInput): string {
  return promptInputTextProjection(input);
}

/** Explicit clipboard-text fallback. Semantic in-process copies must copy a document slice. */
export function promptInputCopyText(input: PromptInput): string {
  return promptInputTextProjection(input);
}
