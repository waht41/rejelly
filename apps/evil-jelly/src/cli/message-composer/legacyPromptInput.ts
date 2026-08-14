import type { LineInputValue, UserAttachment } from "../../shared/host/inputBindings";
import {
  normalizePromptDocument,
  type PromptDocument,
  type PromptNode,
  type PromptToken,
  promptTokens,
} from "../../shared/model/prompt/promptDocument";
import {
  assertValidPromptInput,
  type PromptAttachment,
  type PromptInput,
} from "../../shared/model/prompt/promptInput";

export interface HydratedLegacyAttachments {
  document: PromptDocument;
  attachments: PromptAttachment[];
}

function legacyAttachment(attachment: PromptAttachment): UserAttachment {
  return attachment.kind === "file"
    ? { type: "file", path: attachment.path }
    : {
        type: "image",
        path: attachment.path,
        mimeType: attachment.mimeType,
        ...(attachment.detail ? { detail: attachment.detail } : {}),
      };
}

/** Lossy compatibility projection used only until session dispatch accepts PromptInput. */
export function materializeLegacyPromptInput(
  input: PromptInput,
  tokenDisplayText: (token: PromptToken, document: PromptDocument) => string,
): LineInputValue {
  assertValidPromptInput(input);
  const attachmentsById = new Map(
    input.attachments.map((attachment) => [attachment.id, attachment]),
  );
  const emittedAttachmentIds = new Set<string>();
  const attachments = promptTokens(input.document).flatMap((token) => {
    if (token.kind !== "file" && token.kind !== "image") return [];
    if (emittedAttachmentIds.has(token.attachmentId)) return [];
    emittedAttachmentIds.add(token.attachmentId);
    const attachment = attachmentsById.get(token.attachmentId);
    return attachment ? [legacyAttachment(attachment)] : [];
  });
  const text = input.document
    .map((node) => {
      if (node.type === "text") return node.text;
      return node.kind === "paste" ? node.text : tokenDisplayText(node, input.document);
    })
    .join("");

  return { text, ...(attachments.length > 0 ? { attachments } : {}) };
}

/** Compatibility adapter for queued legacy LineInputValue drafts. */
export function hydrateLegacyAttachments(
  document: PromptDocument,
  legacy: readonly UserAttachment[],
  createId: () => string,
): HydratedLegacyAttachments {
  const files = legacy.filter((attachment) => attachment.type === "file");
  const images = legacy.filter((attachment) => attachment.type === "image");
  const hydrated: PromptAttachment[] = [];
  const used = new Set<UserAttachment>();
  const nodes: PromptNode[] = [];

  for (const node of document) {
    if (node.type !== "text") {
      nodes.push(node);
      continue;
    }
    let offset = 0;
    while (offset < node.text.length) {
      const candidates: Array<{
        start: number;
        end: number;
        attachment: UserAttachment;
      }> = [];
      for (const attachment of files) {
        if (used.has(attachment)) continue;
        const marker = `@${attachment.path}`;
        const start = node.text.indexOf(marker, offset);
        if (start >= 0) candidates.push({ start, end: start + marker.length, attachment });
      }
      for (const [index, attachment] of images.entries()) {
        if (used.has(attachment)) continue;
        const marker = `[Image #${index + 1}]`;
        const start = node.text.indexOf(marker, offset);
        if (start >= 0) candidates.push({ start, end: start + marker.length, attachment });
      }
      const candidate = candidates.sort(
        (left, right) => left.start - right.start || right.end - left.end,
      )[0];
      if (!candidate) break;
      if (offset < candidate.start) {
        nodes.push({ type: "text", text: node.text.slice(offset, candidate.start) });
      }
      const id = createId();
      if (candidate.attachment.type === "file") {
        hydrated.push({ id, kind: "file", path: candidate.attachment.path });
        nodes.push({ type: "token", kind: "file", attachmentId: id });
      } else {
        hydrated.push({
          id,
          kind: "image",
          path: candidate.attachment.path,
          mimeType: candidate.attachment.mimeType ?? "image/png",
          ...(candidate.attachment.detail ? { detail: candidate.attachment.detail } : {}),
          ownership: "borrowed",
        });
        nodes.push({ type: "token", kind: "image", attachmentId: id });
      }
      used.add(candidate.attachment);
      offset = candidate.end;
    }
    if (offset < node.text.length) {
      nodes.push({ type: "text", text: node.text.slice(offset) });
    }
  }

  for (const attachment of legacy) {
    if (used.has(attachment)) continue;
    const id = createId();
    if (nodes.length > 0) nodes.push({ type: "text", text: " " });
    if (attachment.type === "file") {
      hydrated.push({ id, kind: "file", path: attachment.path });
      nodes.push({ type: "token", kind: "file", attachmentId: id });
    } else {
      hydrated.push({
        id,
        kind: "image",
        path: attachment.path,
        mimeType: attachment.mimeType ?? "image/png",
        ...(attachment.detail ? { detail: attachment.detail } : {}),
        ownership: "borrowed",
      });
      nodes.push({ type: "token", kind: "image", attachmentId: id });
    }
  }

  return { document: normalizePromptDocument(nodes), attachments: hydrated };
}
