/**
 * Host-neutral semantic model for one user prompt.
 *
 * Text uses UTF-16 offsets. Every token occupies one logical position regardless of how a host
 * renders it. UI identity, display labels, cursor state, and terminal layout never belong here.
 */

export interface PromptTextNode {
  readonly type: "text";
  readonly text: string;
}

export interface SkillPromptToken {
  readonly type: "token";
  readonly kind: "skill";
  readonly qualifiedName: string;
}

export interface PastePromptToken {
  readonly type: "token";
  readonly kind: "paste";
  readonly text: string;
}

export interface FilePromptToken {
  readonly type: "token";
  readonly kind: "file";
  readonly attachmentId: string;
}

export interface ImagePromptToken {
  readonly type: "token";
  readonly kind: "image";
  readonly attachmentId: string;
}

export type PromptToken = SkillPromptToken | PastePromptToken | FilePromptToken | ImagePromptToken;
export type PromptNode = PromptTextNode | PromptToken;
export type PromptDocument = readonly PromptNode[];

export function promptNodeLogicalLength(node: PromptNode): number {
  return node.type === "text" ? node.text.length : 1;
}

export function promptDocumentLogicalLength(document: PromptDocument): number {
  return document.reduce((length, node) => length + promptNodeLogicalLength(node), 0);
}

/** Remove empty text and merge adjacent text nodes into the canonical runtime representation. */
export function normalizePromptDocument(nodes: readonly PromptNode[]): PromptDocument {
  const normalized: PromptNode[] = [];
  for (const node of nodes) {
    if (node.type !== "text") {
      normalized.push(node);
      continue;
    }
    if (node.text.length === 0) {
      continue;
    }
    const previous = normalized.at(-1);
    if (previous?.type === "text") {
      normalized[normalized.length - 1] = { type: "text", text: previous.text + node.text };
      continue;
    }
    normalized.push(node);
  }
  return normalized;
}

export function textPromptDocument(text: string): PromptDocument {
  return text.length > 0 ? [{ type: "text", text }] : [];
}

/** Whitespace-only text is empty; every well-formed semantic token makes a prompt non-empty. */
export function isPromptDocumentSemanticallyEmpty(document: PromptDocument): boolean {
  return document.every((node) => node.type === "text" && node.text.trim().length === 0);
}

/** Local commands are recognized only from text-only documents. */
export function promptDocumentCommandText(document: PromptDocument): string | undefined {
  let text = "";
  for (const node of document) {
    if (node.type === "token") {
      return undefined;
    }
    text += node.text;
  }
  return text;
}
