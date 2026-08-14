import { randomUUID } from "node:crypto";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type PromptDocument,
  type PromptToken,
  promptTokens,
  type SkillPromptToken,
} from "../../shared/model/prompt/promptDocument";
import type { PromptAttachment } from "../../shared/model/prompt/promptInput";
import {
  concatenatePromptInputs,
  promptInputCommandText,
} from "../../shared/model/prompt/promptInput";
import { defaultPromptTokenDisplayText } from "./editor/document/promptDocument";
import type { TextBuffer } from "./editor/document/textBuffer";
import { useTextBuffer } from "./editor/document/textBuffer";
import { useCollapsedPaste } from "./editor/paste/useCollapsedPaste";
import type { SkillPickerItem } from "./session/composerSession";
import { useComposerSession } from "./session/composerSession";
import {
  selectedSkillReferenceName,
  skillTokensFromDocument,
} from "./suggestions/skill-reference/skillTrigger";

export interface ComposerDraft {
  buffer: TextBuffer;
  selectedFiles: string[];
  selectedSkills: SkillPromptToken[];
  availableSkills: SkillPickerItem[];
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

/** Owns one editable semantic draft and adapts it to the legacy submission boundary. */
export function useComposerDraft({
  label,
  onCommand,
}: {
  label: string;
  onCommand: (text: string) => boolean;
}): ComposerDraft {
  const submitLine = useComposerSession((state) => state.submitLine);
  const availableSkills = useComposerSession((state) => state.availableSkills);
  const draftSeed = useComposerSession((state) => state.draftSeed);
  const clearDraftSeed = useComposerSession((state) => state.clearDraftSeed);
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const createAttachmentId = useCallback(() => `attachment-${randomUUID()}`, []);
  const tokenDisplayText = useCallback(
    (token: PromptToken, document: PromptDocument): string => {
      if (token.kind === "skill") {
        return `$${selectedSkillReferenceName(token, availableSkills)}`;
      }
      if (token.kind === "file") {
        const attachment = attachments.find((candidate) => candidate.id === token.attachmentId);
        return attachment?.kind === "file" ? `@${attachment.path}` : "[File]";
      }
      if (token.kind === "image") {
        const index = promptTokens(document, "image").indexOf(token) + 1;
        return `[Image #${Math.max(1, index)}]`;
      }
      return defaultPromptTokenDisplayText(token);
    },
    [attachments, availableSkills],
  );
  const buffer = useTextBuffer("", tokenDisplayText);
  const collapsedPaste = useCollapsedPaste(buffer);
  const selectedSkills = useMemo(() => skillTokensFromDocument(buffer.document), [buffer.document]);
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
      return referenced.length === current.length &&
        referenced.every((attachment, index) => attachment === current[index])
        ? current
        : referenced;
    });
  }, [buffer.document]);

  const clear = useCallback(() => {
    buffer.reset();
    setAttachments([]);
    collapsedPaste.reset();
  }, [buffer.reset, collapsedPaste.reset]);

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
    clear();
  }, [buffer.document, clear, liveAttachments, onCommand, submitLine]);

  const submitCommand = useCallback(
    (command: string) => {
      if (onCommand(command.trim())) {
        clear();
      }
    },
    [clear, onCommand],
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
    availableSkills,
    attachFile,
    clear,
    submit,
    submitCommand,
    attachImage,
    handleTextPaste: collapsedPaste.handlePaste,
    hasCollapsedPaste: collapsedPaste.hasCollapsedPaste,
  };
}
