/**
 * Line input backed by a single text buffer + caret (see ../../prompt-editor/textBuffer), so
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
 * ../../prompt-editor/softWrap) rather than handing Ink a long line to wrap.
 * The caret is a terminal cell, so it has to be placed in *physical* rows and
 * columns; owning the wrap is what lets the painted rows and the caret's
 * position come from one list instead of two guesses that drift apart.
 */

import type { DOMElement } from "ink";
import { Box, Text, useCursor, useStdout } from "ink";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import stringWidth from "string-width";
import { extractAtQuery, refsMissingFromText, replaceAtToken } from "../../prompt-editor/atTrigger";
import { saveClipboardImage } from "../../prompt-editor/clipboardImage";
import { copyTextToClipboard } from "../../prompt-editor/clipboardText";
import {
  attachedImages,
  coalescePaste,
  expandPastedTextTokens,
  PASTE_COALESCE_MS,
  type PasteRun,
  pastedTextToken,
  pastedTextTokenBefore,
} from "../../prompt-editor/lineText";
import type { ProjectedTokenSpan, SkillPromptToken } from "../../prompt-editor/promptDocument";
import { projectedDisplayRuns } from "../../prompt-editor/promptDocument";
import {
  activeSkillTrigger,
  extractSkillQuery,
  hydrateSkillTokens,
  replaceSkillToken,
  selectedSkillReferenceName,
  skillReferenceName,
  skillReferencesFromDocument,
} from "../../prompt-editor/skillTrigger";
import { extractSlashQuery, filterSlashCommands } from "../../prompt-editor/slashCommands";
import { caretCell, type WrappedRow, wrapRows } from "../../prompt-editor/softWrap";
import { useTextBuffer } from "../../prompt-editor/textBuffer";
import { useLineKeybindings } from "../../prompt-editor/useLineKeybindings";
import { applyModeCommand, MODE_META } from "../../store/useModeStore";
import { isRuntimeActive, useOutputStore } from "../../store/useOutputStore";
import {
  MAX_SELECTED_SKILLS,
  type SkillPickerItem,
  usePromptStore,
} from "../../store/usePromptStore";
import { useViewStore } from "../../store/useViewStore";
import { FilePickerOverlay } from "../pickers/FilePickerOverlay";
import type { PickerKeyHandler } from "../pickers/ListPicker";
import { filterSkillPickerItems, SkillPickerOverlay } from "../pickers/SkillPickerOverlay";
import { SlashCommandOverlay } from "../pickers/SlashCommandOverlay";

const MIN_FILE_PICKER_ROWS = 5;
const MAX_FILE_PICKER_ROWS = 10;
const PASTE_CHUNK_MERGE_MS = 120;
const EXPAND_TOOL_RE = /^\/expand-tool\s+#?(\d+)\s*$/;

interface PastedText {
  id: number;
  text: string;
}

interface PendingPasteChunk {
  id: number;
  updatedAt: number;
}

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

function expandToolCommand(text: string): boolean {
  if (text === "/expand-tool") {
    useViewStore.getState().openTranscript();
    return true;
  }
  const match = text.match(EXPAND_TOOL_RE);
  if (!match) {
    if (text.startsWith("/expand-tool ")) {
      useOutputStore.getState().logSystem("Usage: /expand-tool #N");
      return true;
    }
    return false;
  }

  const ordinal = Number(match[1]);
  const toolTurn = useOutputStore
    .getState()
    .history.filter((turn) => turn.type === "tool")
    .find((turn, index) => (turn.tool.ordinal ?? index + 1) === ordinal);
  if (!toolTurn || toolTurn.type !== "tool") {
    useOutputStore.getState().logSystem(`No tool call #${ordinal}.`);
    return true;
  }

  const border = "".padEnd(40, "─");
  const detailBlock =
    toolTurn.tool.detail?.type === "diff" && toolTurn.tool.detail.text.trim().length > 0
      ? `\nDiff\n${toolTurn.tool.detail.text}\n`
      : toolTurn.tool.args !== undefined && toolTurn.tool.args.trim().length > 0
        ? `\nArguments\n${toolTurn.tool.args}\n`
        : "\n";
  useOutputStore
    .getState()
    .logSystem(
      `#${ordinal} ${toolTurn.tool.toolName}\n${toolTurn.tool.summary}${detailBlock}${border}\n${toolTurn.tool.fullResult}`,
    );
  return true;
}

export function SmartLinePrompt({ label }: { label: string }) {
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
  const phase = useOutputStore((s) => s.runtime.phase);
  const streamBuffer = useOutputStore((s) => s.streamBuffer);
  const rowRef = useRef<DOMElement>(null);
  const buf = useTextBuffer();
  const [textArea, setTextArea] = useState<TextArea | null>(null);
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [skillQuery, setSkillQuery] = useState<string | null>(null);
  const [terminalRows, setTerminalRows] = useState(stdout.rows || 24);
  const [pasteStatus, setPasteStatus] = useState<string | null>(null);
  const [pastedTexts, setPastedTexts] = useState<PastedText[]>([]);
  const [nextPasteId, setNextPasteId] = useState(1);
  const pastedTextsRef = useRef<PastedText[]>([]);
  const pendingPasteChunkRef = useRef<PendingPasteChunk | null>(null);
  const nextPromptTokenIdRef = useRef(1);
  // A run of printable input arriving faster than a human types — a paste
  // fragmented into sub-threshold events. We insert each fragment immediately
  // (no typing latency) and retroactively collapse the run once it grows large.
  const pasteRunRef = useRef<PasteRun | null>(null);
  // Key-claim slot shared with whichever picker overlay is mounted: the picker
  // publishes its handler here and the line keybindings offer it each key first.
  const overlayKeysRef = useRef<PickerKeyHandler | null>(null);

  const isMultiline = buf.text.includes("\n");
  const labelWidth = stringWidth(`${label || "❯"} `);
  // One wrap, used twice: BufferView paints these rows and the caret is placed
  // against them, so the two can't drift apart.
  const wrappedRows = wrapRows(buf.text, textArea?.width ?? 0);
  const caret = caretCell(wrappedRows, buf.cursor);
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

  // The @ picker is single-line only; otherwise track the token at the caret.
  useEffect(() => {
    setAtQuery(isMultiline ? null : extractAtQuery(buf.text, buf.cursor));
  }, [buf.text, buf.cursor, isMultiline]);

  // The slash palette opens on a leading `/` command token (single-line only).
  useEffect(() => {
    setSlashQuery(isMultiline ? null : extractSlashQuery(buf.text, buf.cursor));
  }, [buf.text, buf.cursor, isMultiline]);

  // `$` is only an autocomplete trigger. A Skill becomes active after picker selection stores a
  // structured reference; arbitrary `$text` remains ordinary prompt text.
  useEffect(() => {
    const followsSemanticToken = buf.tokenSpans.some(
      (span) => span.start < buf.cursor && buf.cursor <= span.end,
    );
    setSkillQuery(
      isMultiline || followsSemanticToken ? null : extractSkillQuery(buf.text, buf.cursor),
    );
  }, [buf.text, buf.cursor, buf.tokenSpans, isMultiline]);

  useEffect(() => {
    const present = skillReferencesFromDocument(buf.document);
    const unchanged =
      present.length === selectedSkills.length &&
      present.every(
        (reference, index) => reference.qualifiedName === selectedSkills[index]?.qualifiedName,
      );
    if (!unchanged) {
      setSelectedSkills(present);
    }
  }, [buf.document, selectedSkills, setSelectedSkills]);

  // Reset for a fresh prompt (new label) and on unmount.
  useEffect(() => {
    buf.reset();
    setAtQuery(null);
    setSlashQuery(null);
    setSkillQuery(null);
    clearSelectedFiles();
    clearSelectedImages();
    clearSelectedSkills();
    setPasteStatus(null);
    setPastedTexts([]);
    pastedTextsRef.current = [];
    pendingPasteChunkRef.current = null;
    pasteRunRef.current = null;
    setNextPasteId(1);
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
        () => `skill-${nextPromptTokenIdRef.current++}`,
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
  ]);

  const clearDraft = () => {
    buf.reset();
    setAtQuery(null);
    setSlashQuery(null);
    setSkillQuery(null);
    clearSelectedFiles();
    clearSelectedImages();
    clearSelectedSkills();
    setPasteStatus(null);
    setPastedTexts([]);
    pastedTextsRef.current = [];
    pendingPasteChunkRef.current = null;
    pasteRunRef.current = null;
    setNextPasteId(1);
  };

  const submitText = (text: string) => {
    const expandedText = expandPastedTextTokens(text, pastedTextsRef.current);
    // `/mode` switches modes from the prompt (reliable everywhere, unlike shift+tab); handle it
    // locally instead of sending it to the agent. Works at the idle prompt and while it runs.
    const switched = applyModeCommand(expandedText);
    if (switched) {
      useOutputStore
        .getState()
        .logSystem(`Mode → ${MODE_META[switched].label} (${MODE_META[switched].hint})`);
      clearDraft();
      return;
    }
    if (expandToolCommand(expandedText.trim())) {
      clearDraft();
      return;
    }
    if (expandedText.trim() === "/copy-last") {
      const lastAssistant = [...useOutputStore.getState().history]
        .reverse()
        .find((turn) => turn.type === "assistant");
      if (!lastAssistant) {
        useOutputStore.getState().logSystem("No assistant message to copy.");
        clearDraft();
        return;
      }
      useOutputStore.getState().logSystem("Copying last assistant message...");
      void copyTextToClipboard(lastAssistant.content)
        .then(() => {
          useOutputStore.getState().logSystem("Copied last assistant message to clipboard.");
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          useOutputStore.getState().logSystem(`Copy failed: ${message}`);
        });
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

  const submit = () => submitText(buf.text);

  // Selecting from the slash palette submits the bare command; each command is handled
  // by its owning layer (/mode here, /stop in io.ts, /resume + /exit in MainCliAgent).
  const handleSlashSelect = (name: string) => {
    setSlashQuery(null);
    if (name === "/expand-tool") {
      submitText("/expand-tool");
      return;
    }
    submitText(name);
  };

  const handleFileSelect = (filePath: string) => {
    // Single-select: append the picked file (setSelectedFiles de-dupes), replace
    // the active @token with its @ref, and close the picker.
    setSelectedFiles([...selectedFiles, filePath]);
    buf.apply((s) => replaceAtToken(s, refsMissingFromText(s.text, [filePath])));
    setAtQuery(null);
  };

  const dismissPicker = () => {
    buf.apply((s) => replaceAtToken(s, []));
    setAtQuery(null);
  };

  const handleSkillSelect = (skill: SkillPickerItem) => {
    if (
      selectedSkills.length >= MAX_SELECTED_SKILLS &&
      !selectedSkills.some((selected) => selected.qualifiedName === skill.qualifiedName)
    ) {
      useOutputStore
        .getState()
        .logSystem(`At most ${MAX_SELECTED_SKILLS} Skills can be selected for one input.`);
      buf.apply((state) => replaceSkillToken(state, []));
      setSkillQuery(null);
      return;
    }
    const trigger = activeSkillTrigger(buf.text, buf.cursor);
    if (!trigger) {
      setSkillQuery(null);
      return;
    }
    const token: SkillPromptToken = {
      type: "token",
      kind: "skill",
      id: `skill-${nextPromptTokenIdRef.current++}`,
      qualifiedName: skill.qualifiedName,
      displayText: `$${skillReferenceName(skill, availableSkills)}`,
    };
    const after = buf.text.slice(trigger.end);
    buf.replaceDisplayRange(trigger.start, trigger.end, [
      token,
      ...(after.length === 0 || !/^\s/.test(after) ? [{ type: "text" as const, text: " " }] : []),
    ]);
    setSkillQuery(null);
  };

  const dismissSkillPicker = () => {
    buf.apply((state) => replaceSkillToken(state, []));
    setSkillQuery(null);
  };

  const attachClipboardImage = () => {
    setPasteStatus("Reading clipboard image...");
    void saveClipboardImage().then((result) => {
      if (result.ok) {
        addSelectedImage(result.path);
        // Drop an `[Image #N]` placeholder into the line at the caret; N is the
        // image's 1-based slot, so it maps back to this path on submit.
        const num = usePromptStore.getState().selectedImages.length;
        buf.insert(`[Image #${num}]`);
        setPasteStatus(null);
        return;
      }
      setPasteStatus(result.message);
    });
  };

  const handleTextPaste = (text: string): boolean => {
    const tokenBefore = pastedTextTokenBefore(buf.text, buf.cursor);
    if (tokenBefore) {
      const id = Number(tokenBefore.match(/#(\d+)/)?.[1]);
      const pasted = pastedTextsRef.current.find((entry) => entry.id === id);
      const pending = pendingPasteChunkRef.current;
      const now = Date.now();
      if (pasted && pending?.id === id && now - pending.updatedAt <= PASTE_CHUNK_MERGE_MS) {
        const mergedText = pasted.text + text;
        const nextToken = pastedTextToken(id, mergedText);
        pastedTextsRef.current = pastedTextsRef.current.map((entry) =>
          entry.id === id ? { ...entry, text: mergedText } : entry,
        );
        pendingPasteChunkRef.current = { id, updatedAt: now };
        pasteRunRef.current = null;
        setPastedTexts(pastedTextsRef.current);
        buf.apply((s) => ({
          text: s.text.slice(0, s.cursor - tokenBefore.length) + nextToken + s.text.slice(s.cursor),
          cursor: s.cursor - tokenBefore.length + nextToken.length,
        }));
        setPasteStatus(null);
        return true;
      }
      if (pasted?.text === text) {
        buf.apply((s) => ({
          text: s.text.slice(0, s.cursor - tokenBefore.length) + text + s.text.slice(s.cursor),
          cursor: s.cursor - tokenBefore.length + text.length,
        }));
        pendingPasteChunkRef.current = null;
        pasteRunRef.current = null;
        setPasteStatus(null);
        return true;
      }
    }

    // Fold this fragment into the current run (or start a fresh one) and insert
    // it right away — typing stays latency-free. Only a run that grows past the
    // collapse threshold is promoted to a token, so real typing never collapses.
    const now = Date.now();
    const { run, collapse } = coalescePaste(pasteRunRef.current, text, now, PASTE_COALESCE_MS);
    buf.insert(text);
    if (!collapse) {
      pasteRunRef.current = run;
      setPasteStatus(null);
      return true;
    }

    const accum = run.text;
    const id = nextPasteId;
    const token = pastedTextToken(id, accum);
    pastedTextsRef.current = [...pastedTextsRef.current, { id, text: accum }];
    pendingPasteChunkRef.current = { id, updatedAt: now };
    pasteRunRef.current = null;
    setPastedTexts(pastedTextsRef.current);
    setNextPasteId(id + 1);
    // Retroactively swap the just-inserted run for its token. A functional
    // update composes with the queued inserts from this same burst (reading
    // buf.text/cursor here would be stale); bail if the caret is no longer
    // right after the run (an edit slipped in mid-burst).
    buf.apply((s) => {
      const start = s.cursor - accum.length;
      if (start < 0 || s.text.slice(start, s.cursor) !== accum) {
        return s;
      }
      return {
        text: s.text.slice(0, start) + token + s.text.slice(s.cursor),
        cursor: start + token.length,
      };
    });
    setPasteStatus(null);
    return true;
  };

  // Slash palette takes priority over the @ picker; a line starting with `/` can't hold an
  // active @token anyway. With no matching command the palette stays closed and Enter submits.
  const slashMatches = slashQuery !== null ? filterSlashCommands(slashQuery) : [];
  const slashOpen = slashMatches.length > 0;
  const skillMatches =
    skillQuery === null ? [] : filterSkillPickerItems(availableSkills, skillQuery);
  const skillPickerOpen = skillQuery !== null && skillMatches.length > 0 && !slashOpen;
  const filePickerOpen = atQuery !== null && !slashOpen && !skillPickerOpen;

  useLineKeybindings({
    buf,
    overlayKeys: overlayKeysRef,
    isAgentRunning: isRuntimeActive(phase, streamBuffer),
    selectedFiles,
    selectedImages,
    submitLine,
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
  const hasCollapsedPaste = pastedTexts.some((entry) =>
    buf.text.includes(pastedTextToken(entry.id, entry.text)),
  );
  // Rough budget for how tall the picker may grow — the rows the prompt itself
  // eats. Sizing only; the caret no longer depends on this estimate.
  const promptRows =
    (selectedFiles.length > 0 ? selectedFiles.length + 1 : 0) +
    (selectedSkills.length > 0 ? selectedSkills.length + 1 : 0) +
    wrappedRows.length;
  const filePickerVisibleRows = Math.min(
    MAX_FILE_PICKER_ROWS,
    Math.max(MIN_FILE_PICKER_ROWS, terminalRows - promptRows - promptChromeRows),
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
      {pasteStatus ? (
        <Box marginTop={1}>
          <Text dimColor>{pasteStatus}</Text>
        </Box>
      ) : hasCollapsedPaste ? (
        <Box marginTop={1}>
          <Text dimColor>paste again to expand</Text>
        </Box>
      ) : null}
      {slashOpen ? (
        <SlashCommandOverlay
          commands={slashMatches}
          onSelect={handleSlashSelect}
          onCancel={() => setSlashQuery(null)}
          keySink={overlayKeysRef}
        />
      ) : skillPickerOpen ? (
        <SkillPickerOverlay
          items={skillMatches}
          getReferenceName={(skill) => skillReferenceName(skill, availableSkills)}
          maxVisibleRows={filePickerVisibleRows}
          onSelect={handleSkillSelect}
          onCancel={dismissSkillPicker}
          keySink={overlayKeysRef}
        />
      ) : filePickerOpen ? (
        <FilePickerOverlay
          query={atQuery ?? ""}
          maxVisibleRows={filePickerVisibleRows}
          onSelect={handleFileSelect}
          onCancel={dismissPicker}
          keySink={overlayKeysRef}
        />
      ) : null}
    </Box>
  );
}
