/**
 * Line input backed by a single text buffer + caret (see ../prompt-editor/textBuffer), so
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
 * ../prompt-editor/softWrap) rather than handing Ink a long line to wrap.
 * The caret is a terminal cell, so it has to be placed in *physical* rows and
 * columns; owning the wrap is what lets the painted rows and the caret's
 * position come from one list instead of two guesses that drift apart.
 */

import type { DOMElement } from "ink";
import { Box, Text, useCursor, useStdout } from "ink";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import stringWidth from "string-width";
import { attachedImages } from "../prompt-editor/lineText";
import type { ProjectedTokenSpan } from "../prompt-editor/promptDocument";
import { projectedDisplayRuns } from "../prompt-editor/promptDocument";
import { caretCell, type WrappedRow, wrapRows } from "../prompt-editor/softWrap";
import { useTextBuffer } from "../prompt-editor/textBuffer";
import { useLineKeybindings } from "../prompt-editor/useLineKeybindings";
import { useCollapsedPaste } from "./collapsed-paste/useCollapsedPaste";
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
/**
 * Where the text column sits, measured off the laid-out frame rather than
 * guessed: `x`/`y` are its absolute top-left in terminal cells and `width` is
 * the room it has to wrap in. Everything the caret needs is derived from this,
 * so nothing above the prompt (the attachment list, the steer queue, the
 * "agent is running" notice) has to be counted by hand.
 */
interface TextArea {
  x: number;
  y: number;
  width: number;
}

function absoluteOrigin(node: DOMElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let current: DOMElement | undefined = node;

  while (current) {
    x += current.yogaNode?.getComputedLeft() ?? 0;
    y += current.yogaNode?.getComputedTop() ?? 0;
    current = current.parentNode;
  }

  return { x, y };
}

/**
 * `rowRef` goes on the label+text row, whose width is the full inner width of
 * the bordered prompt box and therefore does not move as the buffer grows —
 * unlike the text column itself, which is content-sized.
 */
function BufferView({
  rowRef,
  label,
  rows,
  tokenSpans,
  placeholder,
}: {
  rowRef: RefObject<DOMElement | null>;
  label: string;
  rows: WrappedRow[];
  tokenSpans: readonly ProjectedTokenSpan[];
  placeholder: string;
}) {
  return (
    <Box ref={rowRef} flexDirection="row">
      <Text bold>{label || "❯"} </Text>
      <Box flexDirection="column">
        {rows.length === 0 ? (
          <Text>
            <Text dimColor>{placeholder}</Text>
          </Text>
        ) : (
          // Rows are already wrapped to fit, so Ink never wraps them again — and
          // the caret's row/column can be read off this very list. Trailing
          // blanks are dropped so a row padded out to the full width can't
          // overflow the column and trigger a second wrap.
          rows.map((row, i) => {
            const rendered = row.text.trimEnd();
            const runs = projectedDisplayRuns(rendered, row.start, tokenSpans);
            return (
              <Text key={i}>
                {runs.length > 0
                  ? runs.map((run, runIndex) =>
                      run.token ? (
                        <Text key={runIndex} color="magenta" bold>
                          {run.text}
                        </Text>
                      ) : (
                        run.text
                      ),
                    )
                  : " "}
              </Text>
            );
          })
        )}
      </Box>
    </Box>
  );
}

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
  const { setCursorPosition } = useCursor();
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
  const rowRef = useRef<DOMElement>(null);
  const buf = useTextBuffer();
  const [textArea, setTextArea] = useState<TextArea | null>(null);
  const [terminalRows, setTerminalRows] = useState(stdout.rows || 24);
  const [clipboardImageStatus, setClipboardImageStatus] = useState<string | null>(null);
  const collapsedPaste = useCollapsedPaste(buf);
  // Key-claim slot shared with whichever picker overlay is mounted: the picker
  // publishes its handler here and the line keybindings offer it each key first.
  const overlayKeysRef = useRef<ComposerPickerKeyHandler | null>(null);

  const isMultiline = buf.text.includes("\n");
  const labelWidth = stringWidth(`${label || "❯"} `);
  // One wrap, used twice: BufferView paints these rows and the caret is placed
  // against them, so the two can't drift apart.
  const wrappedRows = wrapRows(buf.text, textArea?.width ?? 0);
  const caret = caretCell(wrappedRows, buf.cursor, buf.caretAffinity);
  setCursorPosition(
    textArea
      ? { x: textArea.x + caret.col, y: textArea.y + caret.row }
      : // Nothing measured yet (first frame): no honest place to put the caret.
        undefined,
  );

  const shiftImageTokens = (text: string, offset: number): string => {
    if (offset <= 0) {
      return text;
    }
    return text.replace(/\[Image #(\d+)\]/g, (_token, rawIndex: string) => {
      const index = Number.parseInt(rawIndex, 10);
      return Number.isFinite(index) ? `[Image #${index + offset}]` : _token;
    });
  };

  useEffect(() => {
    const updateRows = () => setTerminalRows(stdout.rows || 24);
    updateRows();
    stdout.on("resize", updateRows);
    return () => {
      stdout.off("resize", updateRows);
    };
  }, [stdout]);

  // Measure after every commit: Ink lays Yoga out before layout effects run, so
  // this reads the frame that was just painted. A changed measurement re-renders
  // and the caret catches up on the next frame — which only matters when the
  // prompt actually moves (resize, an attachment added), never while typing,
  // since none of these three values depend on the buffer.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) {
      return;
    }
    const origin = absoluteOrigin(row);
    const next: TextArea = {
      x: origin.x + labelWidth,
      y: origin.y,
      width: (row.yogaNode?.getComputedWidth() ?? 0) - labelWidth,
    };
    setTextArea((previous) =>
      previous?.x === next.x && previous.y === next.y && previous.width === next.width
        ? previous
        : next,
    );
  });

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
        buf.insert(`[Image #${num}]`);
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
    wrappedRows,
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
    wrappedRows.length;
  const suggestionVisibleRows = Math.min(
    MAX_SUGGESTION_ROWS,
    Math.max(MIN_SUGGESTION_ROWS, terminalRows - promptRows - promptChromeRows),
  );

  return (
    <Box flexDirection="column">
      {selectedAttachmentList}
      {selectedSkillList}
      <BufferView
        rowRef={rowRef}
        label={label}
        rows={buf.text.length === 0 ? [] : wrappedRows}
        tokenSpans={buf.tokenSpans}
        placeholder={label || "Message"}
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
