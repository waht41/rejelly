import { randomUUID } from "node:crypto";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { releasePromptAttachments } from "../../shared/host/promptResourceLifecycle";
import {
  type McpPromptToken,
  type MemoryPromptToken,
  type PromptDocument,
  type PromptToken,
  promptTokens,
  type SkillPromptToken,
} from "../../shared/model/prompt/promptDocument";
import {
  concatenatePromptInputs,
  type PromptAttachment,
  type PromptInput,
  promptInputCommandText,
  textPromptInput,
} from "../../shared/model/prompt/promptInput";
import { defaultPromptTokenDisplayText } from "./editor/document/promptDocument";
import type { TextBuffer } from "./editor/document/textBuffer";
import { useTextBuffer } from "./editor/document/textBuffer";
import { useCollapsedPaste } from "./editor/paste/useCollapsedPaste";
import type { McpPickerItem, MemoryPickerItem, SkillPickerItem } from "./session/composerSession";
import { useComposerSession } from "./session/composerSession";
import {
  mcpReferenceName,
  mcpTokensFromDocument,
  memoryReferenceName,
  memoryTokensFromDocument,
  selectedSkillReferenceName,
  skillTokensFromDocument,
} from "./suggestions/skill-reference/skillTrigger";

export interface ComposerDraft {
  buffer: TextBuffer;
  selectedFiles: string[];
  selectedSkills: SkillPromptToken[];
  selectedMcpServers: McpPromptToken[];
  selectedMemories: MemoryPromptToken[];
  availableSkills: SkillPickerItem[];
  availableMcpServers: McpPickerItem[];
  availableMemories: MemoryPickerItem[];
  attachFile: (path: string, start: number, end: number) => void;
  clear: () => void;
  submit: () => void;
  submitCommand: (command: string) => void;
  attachImage: (path: string) => void;
  handleTextPaste: (text: string) => boolean;
  hasCollapsedPaste: boolean;
}

function referencedAttachments(
  document: PromptDocument,
  attachments: readonly PromptAttachment[],
): PromptAttachment[] {
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const seen = new Set<string>();
  return promptTokens(document).flatMap((token) => {
    if (token.kind !== "file" && token.kind !== "image") return [];
    if (seen.has(token.attachmentId)) return [];
    seen.add(token.attachmentId);
    const attachment = byId.get(token.attachmentId);
    return attachment ? [attachment] : [];
  });
}

/** Route a palette selection through the same local-or-router boundary as typed commands. */
export function dispatchSelectedCommand(
  command: string,
  onCommand: (text: string) => boolean,
  submitLine: (input: PromptInput) => void,
): "handled" | "submitted" {
  const normalized = command.trim();
  if (onCommand(normalized)) return "handled";
  submitLine(textPromptInput(normalized));
  return "submitted";
}

/** Owns one editable semantic draft and transfers its PromptInput atomically on submit. */
export function useComposerDraft({
  label,
  onCommand,
}: {
  label: string;
  onCommand: (text: string) => boolean;
}): ComposerDraft {
  const submitLine = useComposerSession((state) => state.submitLine);
  const availableSkills = useComposerSession((state) => state.availableSkills);
  const availableMcpServers = useComposerSession((state) => state.availableMcpServers);
  const availableMemories = useComposerSession((state) => state.availableMemories);
  const draftSeed = useComposerSession((state) => state.draftSeed);
  const clearDraftSeed = useComposerSession((state) => state.clearDraftSeed);
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const attachmentsRef = useRef<PromptAttachment[]>(attachments);
  attachmentsRef.current = attachments;
  const createAttachmentId = useCallback(() => `attachment-${randomUUID()}`, []);
  const tokenDisplayText = useCallback(
    (token: PromptToken, document: PromptDocument): string => {
      if (token.kind === "skill") {
        return `$${selectedSkillReferenceName(token, availableSkills, availableMcpServers)}`;
      }
      if (token.kind === "file") {
        const attachment = attachments.find((candidate) => candidate.id === token.attachmentId);
        return attachment?.kind === "file" ? `@${attachment.path}` : "[File]";
      }
      if (token.kind === "image") {
        const index = promptTokens(document, "image").indexOf(token) + 1;
        return `[Image #${Math.max(1, index)}]`;
      }
      if (token.kind === "mcp") {
        return `$${mcpReferenceName(token, availableSkills)}`;
      }
      if (token.kind === "memory") {
        return `$${memoryReferenceName(
          token,
          availableMemories,
          availableSkills,
          availableMcpServers,
        )}`;
      }
      return defaultPromptTokenDisplayText(token);
    },
    [attachments, availableMcpServers, availableMemories, availableSkills],
  );
  const buffer = useTextBuffer("", tokenDisplayText);
  const collapsedPaste = useCollapsedPaste(buffer);
  const selectedSkills = useMemo(() => skillTokensFromDocument(buffer.document), [buffer.document]);
  const selectedMcpServers = useMemo(
    () => mcpTokensFromDocument(buffer.document),
    [buffer.document],
  );
  const selectedMemories = useMemo(
    () => memoryTokensFromDocument(buffer.document),
    [buffer.document],
  );
  const liveAttachments = useMemo(
    () => referencedAttachments(buffer.document, attachments),
    [attachments, buffer.document],
  );
  const selectedFiles = liveAttachments.flatMap((attachment) =>
    attachment.kind === "file" ? [attachment.path] : [],
  );
  useEffect(() => {
    setAttachments((current) => {
      const referenced = referencedAttachments(buffer.document, current);
      const unchanged =
        referenced.length === current.length &&
        referenced.every((attachment, index) => attachment === current[index])
          ? current
          : referenced;
      if (unchanged === current) return current;
      const retainedIds = new Set(referenced.map((attachment) => attachment.id));
      void releasePromptAttachments(
        current.filter((attachment) => !retainedIds.has(attachment.id)),
      );
      attachmentsRef.current = referenced;
      return referenced;
    });
  }, [buffer.document]);

  const clear = useCallback(() => {
    const discarded = attachmentsRef.current;
    attachmentsRef.current = [];
    buffer.reset();
    setAttachments([]);
    collapsedPaste.reset();
    void releasePromptAttachments(discarded);
  }, [buffer.reset, collapsedPaste.reset]);

  const resetAfterTransfer = useCallback(() => {
    attachmentsRef.current = [];
    buffer.reset();
    setAttachments([]);
    collapsedPaste.reset();
  }, [buffer.reset, collapsedPaste.reset]);

  useEffect(
    () => () => {
      const discarded = attachmentsRef.current;
      attachmentsRef.current = [];
      void releasePromptAttachments(discarded);
    },
    [],
  );

  const attachFile = useCallback(
    (path: string, start: number, end: number) => {
      const normalized = path.trim();
      if (!normalized) return;
      const id = createAttachmentId();
      setAttachments((current) => [...current, { id, kind: "file", path: normalized }]);
      const after = buffer.text.slice(end);
      buffer.replaceDisplayRange(start, end, [
        { type: "token", kind: "file", attachmentId: id },
        ...(after.length === 0 || !/^\s/.test(after) ? [{ type: "text" as const, text: " " }] : []),
      ]);
    },
    [buffer.replaceDisplayRange, buffer.text, createAttachmentId],
  );

  const attachImage = useCallback(
    (path: string) => {
      const normalized = path.trim();
      if (!normalized) return;
      const id = createAttachmentId();
      setAttachments((current) => [
        ...current,
        {
          id,
          kind: "image",
          path: normalized,
          mimeType: "image/png",
          ownership: "composer_temp",
        },
      ]);
      buffer.replaceDisplayRange(buffer.cursor, buffer.cursor, [
        { type: "token", kind: "image", attachmentId: id },
      ]);
    },
    [buffer.cursor, buffer.replaceDisplayRange, createAttachmentId],
  );

  const submit = useCallback(() => {
    const command = promptInputCommandText({
      document: buffer.document,
      attachments: liveAttachments,
    })?.trim();
    if (command && onCommand(command)) {
      clear();
      return;
    }
    submitLine({ document: buffer.document, attachments: liveAttachments });
    resetAfterTransfer();
  }, [buffer.document, clear, liveAttachments, onCommand, resetAfterTransfer, submitLine]);

  const submitCommand = useCallback(
    (command: string) => {
      if (dispatchSelectedCommand(command, onCommand, submitLine) === "handled") {
        clear();
        return;
      }
      resetAfterTransfer();
    },
    [clear, onCommand, resetAfterTransfer, submitLine],
  );

  useEffect(() => {
    clear();
  }, [label, clear]);

  useEffect(() => {
    if (!draftSeed) return;
    const merged = concatenatePromptInputs([
      draftSeed.value,
      {
        document: buffer.document,
        attachments: referencedAttachments(buffer.document, attachments),
      },
    ]);
    setAttachments([...merged.attachments]);
    buffer.setDocument(merged.document);
    clearDraftSeed(draftSeed.id);
  }, [attachments, buffer.document, buffer.setDocument, clearDraftSeed, draftSeed]);

  return {
    buffer,
    selectedFiles,
    selectedSkills,
    selectedMcpServers,
    selectedMemories,
    availableSkills,
    availableMcpServers,
    availableMemories,
    attachFile,
    clear,
    submit,
    submitCommand,
    attachImage,
    handleTextPaste: collapsedPaste.handlePaste,
    hasCollapsedPaste: collapsedPaste.hasCollapsedPaste,
  };
}
