import { useCallback, useEffect, useRef } from "react";
import type { UserAttachment, UserSkillReference } from "../../shared/host/inputBindings";
import type { TextBuffer } from "./editor/document/textBuffer";
import { useTextBuffer } from "./editor/document/textBuffer";
import { useCollapsedPaste } from "./editor/paste/useCollapsedPaste";
import { attachedImages, imageToken, shiftImageTokens } from "./imageAttachments";
import type { SkillPickerItem } from "./session/composerStore";
import { usePromptStore } from "./session/composerStore";
import {
  hydrateSkillTokens,
  selectedSkillReferenceName,
  skillReferencesFromDocument,
} from "./suggestions/skill-reference/skillTrigger";

export interface ComposerDraft {
  buffer: TextBuffer;
  selectedFiles: string[];
  selectedImages: string[];
  selectedSkills: UserSkillReference[];
  availableSkills: SkillPickerItem[];
  setSelectedFiles: (paths: string[]) => void;
  removeSelectedFile: (path: string) => void;
  clear: () => void;
  submitText: (text: string) => void;
  attachImage: (path: string) => void;
  handleTextPaste: (text: string) => boolean;
  hasCollapsedPaste: boolean;
  createSkillTokenId: () => string;
}

/** Owns one editable draft from hydration through materialization and submission. */
export function useComposerDraft({
  label,
  onCommand,
}: {
  label: string;
  onCommand: (text: string) => boolean;
}): ComposerDraft {
  const submitLine = usePromptStore((state) => state.submitLine);
  const selectedFiles = usePromptStore((state) => state.selectedFiles);
  const selectedImages = usePromptStore((state) => state.selectedImages);
  const selectedSkills = usePromptStore((state) => state.selectedSkills);
  const availableSkills = usePromptStore((state) => state.availableSkills);
  const draftSeed = usePromptStore((state) => state.draftSeed);
  const setSelectedFiles = usePromptStore((state) => state.setSelectedFiles);
  const setSelectedImages = usePromptStore((state) => state.setSelectedImages);
  const setSelectedSkills = usePromptStore((state) => state.setSelectedSkills);
  const removeSelectedFile = usePromptStore((state) => state.removeSelectedFile);
  const clearSelectedFiles = usePromptStore((state) => state.clearSelectedFiles);
  const addSelectedImage = usePromptStore((state) => state.addSelectedImage);
  const clearSelectedImages = usePromptStore((state) => state.clearSelectedImages);
  const clearSelectedSkills = usePromptStore((state) => state.clearSelectedSkills);
  const clearDraftSeed = usePromptStore((state) => state.clearDraftSeed);
  const buffer = useTextBuffer();
  const collapsedPaste = useCollapsedPaste(buffer);
  const nextSkillTokenIdRef = useRef(1);

  const createSkillTokenId = useCallback(() => `skill-${nextSkillTokenIdRef.current++}`, []);

  const clear = useCallback(() => {
    buffer.reset();
    clearSelectedFiles();
    clearSelectedImages();
    clearSelectedSkills();
    collapsedPaste.reset();
    nextSkillTokenIdRef.current = 1;
  }, [
    buffer.reset,
    clearSelectedFiles,
    clearSelectedImages,
    clearSelectedSkills,
    collapsedPaste.reset,
  ]);

  const submitText = useCallback(
    (text: string) => {
      const expandedText = collapsedPaste.expand(text);
      if (onCommand(expandedText.trim())) {
        clear();
        return;
      }
      const attachments: UserAttachment[] = [
        ...selectedFiles.map((path) => ({ type: "file" as const, path })),
        ...attachedImages(expandedText, selectedImages).map((path) => ({
          type: "image" as const,
          path,
          mimeType: "image/png" as const,
        })),
      ];
      submitLine(expandedText, attachments, skillReferencesFromDocument(buffer.document));
      clear();
    },
    [
      buffer.document,
      clear,
      collapsedPaste.expand,
      onCommand,
      selectedFiles,
      selectedImages,
      submitLine,
    ],
  );

  const attachImage = useCallback(
    (path: string) => {
      addSelectedImage(path);
      const imageCount = usePromptStore.getState().selectedImages.length;
      buffer.insert(imageToken(imageCount));
    },
    [addSelectedImage, buffer.insert],
  );

  // Keep the external compatibility selection synchronized with semantic Skill tokens.
  useEffect(() => {
    const present = skillReferencesFromDocument(buffer.document);
    const unchanged =
      present.length === selectedSkills.length &&
      present.every(
        (reference, index) => reference.qualifiedName === selectedSkills[index]?.qualifiedName,
      );
    if (!unchanged) {
      setSelectedSkills(present);
    }
  }, [buffer.document, selectedSkills, setSelectedSkills]);

  // A new prompt identity starts with an empty draft; unmount drops local selections too.
  useEffect(() => {
    clear();
    return () => {
      clearSelectedFiles();
      clearSelectedImages();
      clearSelectedSkills();
    };
  }, [label, clear, clearSelectedFiles, clearSelectedImages, clearSelectedSkills]);

  // Restore queued steers into the live editor exactly once.
  useEffect(() => {
    if (!draftSeed) {
      return;
    }
    const attachments = draftSeed.value.attachments ?? [];
    const seedFiles = attachments
      .filter((attachment) => attachment.type === "file")
      .map((attachment) => attachment.path);
    const seedImages = attachments
      .filter((attachment) => attachment.type === "image")
      .map((attachment) => attachment.path);
    const seedText = draftSeed.value.text.trim();
    const currentText = shiftImageTokens(buffer.text.trim(), seedImages.length);
    const combinedText = [seedText, currentText].filter((text) => text.length > 0).join("\n");
    const restoredSkills = [...(draftSeed.value.skills ?? []), ...selectedSkills];

    buffer.setDocument(
      hydrateSkillTokens(
        combinedText,
        restoredSkills,
        (reference) => selectedSkillReferenceName(reference, availableSkills),
        createSkillTokenId,
      ),
    );
    setSelectedFiles([...seedFiles, ...selectedFiles]);
    setSelectedImages([...seedImages, ...selectedImages]);
    setSelectedSkills(restoredSkills);
    clearDraftSeed(draftSeed.id);
  }, [
    draftSeed,
    buffer.setDocument,
    buffer.text,
    selectedFiles,
    selectedImages,
    selectedSkills,
    availableSkills,
    setSelectedFiles,
    setSelectedImages,
    setSelectedSkills,
    clearDraftSeed,
    createSkillTokenId,
  ]);

  return {
    buffer,
    selectedFiles,
    selectedImages,
    selectedSkills,
    availableSkills,
    setSelectedFiles,
    removeSelectedFile,
    clear,
    submitText,
    attachImage,
    handleTextPaste: collapsedPaste.handlePaste,
    hasCollapsedPaste: collapsedPaste.hasCollapsedPaste,
    createSkillTokenId,
  };
}
