/**
 * Line input backed by a single text buffer + caret (see ./editor/document/textBuffer), so
 * single- and multi-line editing share one model with full caret movement
 * (←/→, ↑/↓, Home/End, word-jump) and editing (backspace, word/line delete).
 *
 * Submit: Enter submits. Insert a newline with Alt+Enter / Shift+Enter (where
 * the terminal sends them) or by ending the line with a backslash before Enter.
 * Short pasted text keeps its own newlines, so a pasted block never submits early.
 * Long pasted text is collapsed into a `[Pasted text #N +X lines]` token and
 * expanded again before submit.
 *
 * @-trigger: typing @ opens a fuzzy file picker; selecting a file inserts an
 * `@path` ref at the caret and attaches it to this turn (single-select).
 *
 * $-trigger: typing $ opens the enabled Skill picker; selecting one inserts a semantic token
 * whose display name is qualified only when the catalog is ambiguous.
 *
 * Clipboard image: Alt+V (or Ctrl+V, which arrives as garbage bytes and is
 * detected) attaches an image from the OS clipboard. It drops an `[Image #N]`
 * token into the line at the caret — editable/deletable like any other text;
 * deleting the token drops the image from the submitted turn.
 *
 * Rendering: the prompt soft-wraps the buffer itself (see
 * ./editor/softWrap) rather than handing Ink a long line to wrap.
 * The caret is a terminal cell, so it has to be placed in *physical* rows and
 * columns; owning the wrap is what lets the painted rows and the caret's
 * position come from one list instead of two guesses that drift apart.
 */

import { Box, Text, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import { BufferView } from "./editor/BufferView";
import { useTextBuffer } from "./editor/document/textBuffer";
import { useLineKeybindings } from "./editor/keyboard/useLineKeybindings";
import { useCollapsedPaste } from "./editor/paste/useCollapsedPaste";
import { usePromptLayout } from "./editor/usePromptLayout";
import { attachedImages, imageToken, shiftImageTokens } from "./imageAttachments";
import { MAX_SELECTED_SKILLS, usePromptStore } from "./session/composerStore";
import type { ComposerPickerKeyHandler } from "./suggestions/ComposerPicker";
import { ComposerSuggestionOverlay } from "./suggestions/ComposerSuggestionOverlay";
import { useCommandSuggestion } from "./suggestions/commands/useCommandSuggestion";
import { useFileReferenceSuggestion } from "./suggestions/file-reference/useFileReferenceSuggestion";
import {
  hydrateSkillTokens,
  selectedSkillReferenceName,
  skillReferencesFromDocument,
} from "./suggestions/skill-reference/skillTrigger";
import { useSkillReferenceSuggestion } from "./suggestions/skill-reference/useSkillReferenceSuggestion";

const MIN_SUGGESTION_ROWS = 5;
const MAX_SUGGESTION_ROWS = 10;

export type ClipboardImageReadResult = { ok: true; path: string } | { ok: false; message: string };

export interface MessageComposerProps {
  label: string;
  isAgentRunning: boolean;
  hasInterruptibleTask: () => boolean;
  onInterrupt: () => void;
  onCycleMode: () => void;
  onCommand: (text: string) => boolean;
  onNotice: (message: string) => void;
  readClipboardImage: () => Promise<ClipboardImageReadResult>;
}

export function MessageComposer({
  label,
  isAgentRunning,
  hasInterruptibleTask,
  onInterrupt,
  onCycleMode,
  onCommand,
  onNotice,
  readClipboardImage,
}: MessageComposerProps) {
  const { stdout } = useStdout();
  const submitLine = usePromptStore((s) => s.submitLine);
  const selectedFiles = usePromptStore((s) => s.selectedFiles);
  const selectedImages = usePromptStore((s) => s.selectedImages);
  const selectedSkills = usePromptStore((s) => s.selectedSkills);
  const availableSkills = usePromptStore((s) => s.availableSkills);
  const draftSeed = usePromptStore((s) => s.draftSeed);
  const setSelectedFiles = usePromptStore((s) => s.setSelectedFiles);
  const setSelectedImages = usePromptStore((s) => s.setSelectedImages);
  const setSelectedSkills = usePromptStore((s) => s.setSelectedSkills);
  const removeSelectedFile = usePromptStore((s) => s.removeSelectedFile);
  const clearSelectedFiles = usePromptStore((s) => s.clearSelectedFiles);
  const addSelectedImage = usePromptStore((s) => s.addSelectedImage);
  const clearSelectedImages = usePromptStore((s) => s.clearSelectedImages);
  const clearSelectedSkills = usePromptStore((s) => s.clearSelectedSkills);
  const clearDraftSeed = usePromptStore((s) => s.clearDraftSeed);
  const buf = useTextBuffer();
  const [terminalRows, setTerminalRows] = useState(stdout.rows || 24);
  const [clipboardImageStatus, setClipboardImageStatus] = useState<string | null>(null);
  const collapsedPaste = useCollapsedPaste(buf);
  // Key-claim slot shared with whichever picker overlay is mounted: the picker
  // publishes its handler here and the line keybindings offer it each key first.
  const overlayKeysRef = useRef<ComposerPickerKeyHandler | null>(null);

  const isMultiline = buf.text.includes("\n");
  const promptLayout = usePromptLayout({
    text: buf.text,
    cursor: buf.cursor,
    caretAffinity: buf.caretAffinity,
    label,
  });

  useEffect(() => {
    const updateRows = () => setTerminalRows(stdout.rows || 24);
    updateRows();
    stdout.on("resize", updateRows);
    return () => {
      stdout.off("resize", updateRows);
    };
  }, [stdout]);

  const clearDraft = () => {
    buf.reset();
    clearSelectedFiles();
    clearSelectedImages();
    clearSelectedSkills();
    setClipboardImageStatus(null);
    collapsedPaste.reset();
  };

  const submitText = (text: string) => {
    const expandedText = collapsedPaste.expand(text);
    if (onCommand(expandedText.trim())) {
      clearDraft();
      return;
    }
    // Only images whose `[Image #N]` token still survives in the text are sent —
    // deleting the token drops the image.
    submitLine(
      expandedText,
      [
        ...selectedFiles.map((path) => ({ type: "file" as const, path })),
        ...attachedImages(expandedText, selectedImages).map((path) => ({
          type: "image" as const,
          path,
          mimeType: "image/png" as const,
        })),
      ],
      skillReferencesFromDocument(buf.document),
    );
    clearDraft();
  };

  const commandSuggestion = useCommandSuggestion({
    text: buf.text,
    cursor: buf.cursor,
    isMultiline,
    onSelect: submitText,
  });
  const fileSuggestion = useFileReferenceSuggestion({
    buffer: buf,
    selectedFiles,
    setSelectedFiles,
  });
  const skillSuggestion = useSkillReferenceSuggestion({
    buffer: buf,
    availableSkills,
    selectedSkills,
    setSelectedSkills,
    maxSelectedSkills: MAX_SELECTED_SKILLS,
    onNotice,
  });

  // Reset for a fresh prompt (new label) and on unmount.
  useEffect(() => {
    buf.reset();
    clearSelectedFiles();
    clearSelectedImages();
    clearSelectedSkills();
    setClipboardImageStatus(null);
    collapsedPaste.reset();
    return () => {
      clearSelectedFiles();
      clearSelectedImages();
      clearSelectedSkills();
    };
  }, [label, buf.reset, clearSelectedFiles, clearSelectedImages, clearSelectedSkills]);

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
    const currentText = shiftImageTokens(buf.text.trim(), seedImages.length);
    const combinedText = [seedText, currentText].filter((text) => text.length > 0).join("\n");
    const restoredSkills = [...(draftSeed.value.skills ?? []), ...selectedSkills];

    buf.setDocument(
      hydrateSkillTokens(
        combinedText,
        restoredSkills,
        (reference) => selectedSkillReferenceName(reference, availableSkills),
        skillSuggestion.createTokenId,
      ),
    );
    setSelectedFiles([...seedFiles, ...selectedFiles]);
    setSelectedImages([...seedImages, ...selectedImages]);
    setSelectedSkills(restoredSkills);
    clearDraftSeed(draftSeed.id);
  }, [
    draftSeed,
    buf,
    selectedFiles,
    selectedImages,
    selectedSkills,
    availableSkills,
    setSelectedFiles,
    setSelectedImages,
    setSelectedSkills,
    clearDraftSeed,
    skillSuggestion.createTokenId,
  ]);

  const submit = () => submitText(buf.text);

  const attachClipboardImage = () => {
    setClipboardImageStatus("Reading clipboard image...");
    void readClipboardImage().then((result) => {
      if (result.ok) {
        addSelectedImage(result.path);
        // Drop an `[Image #N]` placeholder into the line at the caret; N is the
        // image's 1-based slot, so it maps back to this path on submit.
        const num = usePromptStore.getState().selectedImages.length;
        buf.insert(imageToken(num));
        setClipboardImageStatus(null);
        return;
      }
      setClipboardImageStatus(result.message);
    });
  };

  const handleTextPaste = (text: string): boolean => {
    setClipboardImageStatus(null);
    return collapsedPaste.handlePaste(text);
  };

  useLineKeybindings({
    buf,
    wrappedRows: promptLayout.rows,
    overlayKeys: overlayKeysRef,
    isAgentRunning,
    hasInterruptibleTask,
    onInterrupt,
    onCycleMode,
    selectedFiles,
    selectedImages,
    removeSelectedFile,
    clearDraft,
    submit,
    attachClipboardImage,
    handleTextPaste,
  });

  // Images render inline as `[Image #N]` tokens in the line; only files are
  // listed here.
  const selectedAttachmentList =
    selectedFiles.length > 0 ? (
      <Box flexDirection="column" marginBottom={1}>
        {selectedFiles.map((file) => (
          <Box key={file} flexDirection="row">
            <Text color="green">+ </Text>
            <Text>{file}</Text>
          </Box>
        ))}
      </Box>
    ) : null;

  const selectedSkillList =
    selectedSkills.length > 0 ? (
      <Box flexDirection="column" marginBottom={1}>
        {selectedSkills.map((skill) => (
          <Box key={skill.qualifiedName} flexDirection="row">
            <Text color="magenta">$ </Text>
            <Text>{selectedSkillReferenceName(skill, availableSkills)}</Text>
          </Box>
        ))}
      </Box>
    ) : null;

  const promptChromeRows = 4;
  // Rough budget for how tall the picker may grow — the rows the prompt itself
  // eats. Sizing only; the caret no longer depends on this estimate.
  const promptRows =
    (selectedFiles.length > 0 ? selectedFiles.length + 1 : 0) +
    (selectedSkills.length > 0 ? selectedSkills.length + 1 : 0) +
    promptLayout.rows.length;
  const suggestionVisibleRows = Math.min(
    MAX_SUGGESTION_ROWS,
    Math.max(MIN_SUGGESTION_ROWS, terminalRows - promptRows - promptChromeRows),
  );

  return (
    <Box flexDirection="column">
      {selectedAttachmentList}
      {selectedSkillList}
      <BufferView
        rowRef={promptLayout.rowRef}
        label={label}
        rows={promptLayout.rows}
        tokenSpans={buf.tokenSpans}
        placeholder={label || "Message"}
        empty={buf.text.length === 0}
      />
      {isMultiline ? (
        <Box marginTop={1}>
          <Text color="yellow" dimColor>
            [Multi-line] Enter submits · \ + Enter for newline
          </Text>
        </Box>
      ) : null}
      {clipboardImageStatus ? (
        <Box marginTop={1}>
          <Text dimColor>{clipboardImageStatus}</Text>
        </Box>
      ) : collapsedPaste.hasCollapsedPaste ? (
        <Box marginTop={1}>
          <Text dimColor>paste again to expand</Text>
        </Box>
      ) : null}
      <ComposerSuggestionOverlay
        command={commandSuggestion}
        skill={skillSuggestion}
        file={fileSuggestion}
        availableSkills={availableSkills}
        visibleRows={suggestionVisibleRows}
        keySink={overlayKeysRef}
      />
    </Box>
  );
}
