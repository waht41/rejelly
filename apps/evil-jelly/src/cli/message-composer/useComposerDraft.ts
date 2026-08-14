import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UserSkillReference } from "../../shared/host/inputBindings";
import {
  normalizePromptDocument,
  type PromptDocument,
  type PromptToken,
  promptTokens,
} from "../../shared/model/prompt/promptDocument";
import type { PromptAttachment } from "../../shared/model/prompt/promptInput";
import { defaultPromptTokenDisplayText } from "./editor/document/promptDocument";
import type { TextBuffer } from "./editor/document/textBuffer";
import { useTextBuffer } from "./editor/document/textBuffer";
import { useCollapsedPaste } from "./editor/paste/useCollapsedPaste";
import { hydrateLegacyAttachments, materializeLegacyPromptInput } from "./legacyPromptInput";
import type { SkillPickerItem } from "./session/composerSession";
import { useComposerSession } from "./session/composerSession";
import {
  hydrateSkillTokens,
  selectedSkillReferenceName,
  skillReferencesFromDocument,
} from "./suggestions/skill-reference/skillTrigger";

export interface ComposerDraft {
  buffer: TextBuffer;
  selectedFiles: string[];
  selectedSkills: UserSkillReference[];
  availableSkills: SkillPickerItem[];
  attachFile: (path: string, start: number, end: number) => void;
  clear: () => void;
  submitText: (text: string) => void;
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
  const nextAttachmentIdRef = useRef(1);
  const createAttachmentId = useCallback(() => `attachment-${nextAttachmentIdRef.current++}`, []);
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
  const selectedSkills = useMemo(
    () => skillReferencesFromDocument(buffer.document),
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
    nextAttachmentIdRef.current = 1;
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

  const submitText = useCallback(
    (text: string) => {
      if (onCommand(text.trim())) {
        clear();
        return;
      }
      const live = referencedAttachments(buffer.document, attachments);
      const legacyInput = materializeLegacyPromptInput(
        { document: buffer.document, attachments: live },
        tokenDisplayText,
      );
      submitLine({
        ...legacyInput,
        text: legacyInput.text.trim(),
        ...(selectedSkills.length > 0 ? { skills: selectedSkills } : {}),
      });
      clear();
    },
    [attachments, buffer.document, clear, onCommand, selectedSkills, submitLine, tokenDisplayText],
  );

  useEffect(() => {
    clear();
  }, [label, clear]);

  useEffect(() => {
    if (!draftSeed) return;
    const seedSkills = draftSeed.value.skills ?? [];
    const skillDocument = hydrateSkillTokens(draftSeed.value.text.trim(), seedSkills, (reference) =>
      selectedSkillReferenceName(reference, availableSkills),
    );
    const hydrated = hydrateLegacyAttachments(
      skillDocument,
      draftSeed.value.attachments ?? [],
      createAttachmentId,
    );
    const document = normalizePromptDocument([
      ...hydrated.document,
      ...(hydrated.document.length > 0 && buffer.document.length > 0
        ? [{ type: "text" as const, text: "\n" }]
        : []),
      ...buffer.document,
    ]);
    setAttachments([...hydrated.attachments, ...attachments]);
    buffer.setDocument(document);
    clearDraftSeed(draftSeed.id);
  }, [
    attachments,
    availableSkills,
    buffer.document,
    buffer.setDocument,
    clearDraftSeed,
    createAttachmentId,
    draftSeed,
  ]);

  return {
    buffer,
    selectedFiles,
    selectedSkills,
    availableSkills,
    attachFile,
    clear,
    submitText,
    attachImage,
    handleTextPaste: collapsedPaste.handlePaste,
    hasCollapsedPaste: collapsedPaste.hasCollapsedPaste,
  };
}
