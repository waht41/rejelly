import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UserAttachment, UserSkillReference } from "../../shared/host/inputBindings";
import type { TextBuffer } from "./editor/document/textBuffer";
import { useTextBuffer } from "./editor/document/textBuffer";
import { useCollapsedPaste } from "./editor/paste/useCollapsedPaste";
import { attachedImages, imageToken, shiftImageTokens } from "./imageAttachments";
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

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const normalized = path.trim();
    if (!normalized || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

/** Owns one editable draft from hydration through materialization and submission. */
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
  const [selectedFiles, setSelectedFilesState] = useState<string[]>([]);
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const buffer = useTextBuffer();
  const collapsedPaste = useCollapsedPaste(buffer);
  const nextSkillTokenIdRef = useRef(1);
  const selectedSkills = useMemo(
    () => skillReferencesFromDocument(buffer.document),
    [buffer.document],
  );

  const setSelectedFiles = useCallback((paths: string[]) => {
    setSelectedFilesState(uniquePaths(paths));
  }, []);

  const removeSelectedFile = useCallback((path: string) => {
    setSelectedFilesState((files) => files.filter((selected) => selected !== path));
  }, []);

  const createSkillTokenId = useCallback(() => `skill-${nextSkillTokenIdRef.current++}`, []);

  const clear = useCallback(() => {
    buffer.reset();
    setSelectedFilesState([]);
    setSelectedImages([]);
    collapsedPaste.reset();
    nextSkillTokenIdRef.current = 1;
  }, [buffer.reset, collapsedPaste.reset]);

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
      submitLine({
        text: expandedText.trim(),
        attachments,
        ...(selectedSkills.length > 0 ? { skills: selectedSkills } : {}),
      });
      clear();
    },
    [
      clear,
      collapsedPaste.expand,
      onCommand,
      selectedFiles,
      selectedImages,
      selectedSkills,
      submitLine,
    ],
  );

  const attachImage = useCallback(
    (path: string) => {
      const normalized = path.trim();
      if (!normalized) {
        return;
      }
      const existingIndex = selectedImages.indexOf(normalized);
      const imageIndex = existingIndex >= 0 ? existingIndex + 1 : selectedImages.length + 1;
      if (existingIndex < 0) {
        setSelectedImages((images) => [...images, normalized]);
      }
      buffer.insert(imageToken(imageIndex));
    },
    [buffer.insert, selectedImages],
  );

  // A new prompt identity starts with an empty local draft.
  useEffect(() => {
    clear();
  }, [label, clear]);

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
    setSelectedImages(uniquePaths([...seedImages, ...selectedImages]));
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
