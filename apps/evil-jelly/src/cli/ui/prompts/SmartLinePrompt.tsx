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
 * Clipboard image: Alt+V (or Ctrl+V, which arrives as garbage bytes and is
 * detected) attaches an image from the OS clipboard. It drops an `[Image #N]`
 * token into the line at the caret — editable/deletable like any other text;
 * deleting the token drops the image from the submitted turn.
 */

import type { DOMElement } from "ink";
import { Box, Text, useCursor, useStdout } from "ink";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { extractSlashQuery, filterSlashCommands } from "../../prompt-editor/slashCommands";
import { cursorRowCol, useTextBuffer } from "../../prompt-editor/textBuffer";
import { useLineKeybindings } from "../../prompt-editor/useLineKeybindings";
import { applyModeCommand, MODE_META } from "../../store/useModeStore";
import { isRuntimeActive, useOutputStore } from "../../store/useOutputStore";
import { usePromptStore } from "../../store/usePromptStore";
import { useViewStore } from "../../store/useViewStore";
import { FilePickerOverlay } from "../pickers/FilePickerOverlay";
import type { PickerKeyHandler } from "../pickers/ListPicker";
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

interface Origin {
  x: number;
  y: number;
}

function absoluteOrigin(node: DOMElement): Origin {
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

function cursorCellPosition(text: string, cursor: number) {
  const { row, col } = cursorRowCol(text, cursor);
  const line = text.split("\n")[row] ?? "";
  return { row, col: stringWidth(line.slice(0, col)) };
}

function BufferView({
  label,
  text,
  placeholder,
}: {
  label: string;
  text: string;
  placeholder: string;
}) {
  const lines = text.split("\n");
  return (
    <Box flexDirection="row">
      <Text bold>{label || "❯"} </Text>
      <Box flexDirection="column">
        {text.length === 0 ? (
          <Text>
            <Text dimColor>{placeholder}</Text>
          </Text>
        ) : (
          lines.map((line, i) => <Text key={i}>{line.length > 0 ? line : " "}</Text>)
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
  const draftSeed = usePromptStore((s) => s.draftSeed);
  const setSelectedFiles = usePromptStore((s) => s.setSelectedFiles);
  const setSelectedImages = usePromptStore((s) => s.setSelectedImages);
  const removeSelectedFile = usePromptStore((s) => s.removeSelectedFile);
  const clearSelectedFiles = usePromptStore((s) => s.clearSelectedFiles);
  const addSelectedImage = usePromptStore((s) => s.addSelectedImage);
  const clearSelectedImages = usePromptStore((s) => s.clearSelectedImages);
  const clearDraftSeed = usePromptStore((s) => s.clearDraftSeed);
  const status = useOutputStore((s) => s.status);
  const streamBuffer = useOutputStore((s) => s.streamBuffer);
  const promptRef = useRef<DOMElement>(null);
  const buf = useTextBuffer();
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [terminalRows, setTerminalRows] = useState(stdout.rows || 24);
  const [pasteStatus, setPasteStatus] = useState<string | null>(null);
  const [pastedTexts, setPastedTexts] = useState<PastedText[]>([]);
  const [nextPasteId, setNextPasteId] = useState(1);
  const pastedTextsRef = useRef<PastedText[]>([]);
  const pendingPasteChunkRef = useRef<PendingPasteChunk | null>(null);
  // A run of printable input arriving faster than a human types — a paste
  // fragmented into sub-threshold events. We insert each fragment immediately
  // (no typing latency) and retroactively collapse the run once it grows large.
  const pasteRunRef = useRef<PasteRun | null>(null);
  // Key-claim slot shared with whichever picker overlay is mounted: the picker
  // publishes its handler here and the line keybindings offer it each key first.
  const overlayKeysRef = useRef<PickerKeyHandler | null>(null);

  const isMultiline = buf.text.includes("\n");
  const caret = cursorCellPosition(buf.text, buf.cursor);
  const labelWidth = stringWidth(`${label || "❯"} `);
  const selectedFileRows = selectedFiles.length > 0 ? selectedFiles.length + 1 : 0;
  const cursorPosition = {
    x: (origin?.x ?? 0) + labelWidth + caret.col,
    y: (origin?.y ?? 0) + selectedFileRows + caret.row,
  };
  setCursorPosition(origin ? cursorPosition : undefined);

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

  useLayoutEffect(() => {
    if (!promptRef.current) {
      return;
    }
    const nextOrigin = absoluteOrigin(promptRef.current);
    setOrigin((previousOrigin) =>
      previousOrigin?.x === nextOrigin.x && previousOrigin.y === nextOrigin.y
        ? previousOrigin
        : nextOrigin,
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

  // Reset for a fresh prompt (new label) and on unmount.
  useEffect(() => {
    buf.reset();
    setAtQuery(null);
    setSlashQuery(null);
    clearSelectedFiles();
    clearSelectedImages();
    setPasteStatus(null);
    setPastedTexts([]);
    pastedTextsRef.current = [];
    pendingPasteChunkRef.current = null;
    pasteRunRef.current = null;
    setNextPasteId(1);
    return () => {
      clearSelectedFiles();
      clearSelectedImages();
    };
  }, [label, buf.reset, clearSelectedFiles, clearSelectedImages]);

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

    buf.setText(combinedText);
    setSelectedFiles([...seedFiles, ...selectedFiles]);
    setSelectedImages([...seedImages, ...selectedImages]);
    clearDraftSeed(draftSeed.id);
  }, [
    draftSeed,
    buf,
    selectedFiles,
    selectedImages,
    setSelectedFiles,
    setSelectedImages,
    clearDraftSeed,
  ]);

  const clearDraft = () => {
    buf.reset();
    setAtQuery(null);
    setSlashQuery(null);
    clearSelectedFiles();
    clearSelectedImages();
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
    submitLine(expandedText, [
      ...selectedFiles.map((path) => ({ type: "file" as const, path })),
      ...attachedImages(expandedText, selectedImages).map((path) => ({
        type: "image" as const,
        path,
        mimeType: "image/png" as const,
      })),
    ]);
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
  const filePickerOpen = atQuery !== null && !slashOpen;

  useLineKeybindings({
    buf,
    overlayKeys: overlayKeysRef,
    isAgentRunning: isRuntimeActive(status, streamBuffer),
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

  const promptChromeRows = 4;
  const hasCollapsedPaste = pastedTexts.some((entry) =>
    buf.text.includes(pastedTextToken(entry.id, entry.text)),
  );
  const filePickerVisibleRows = Math.min(
    MAX_FILE_PICKER_ROWS,
    Math.max(MIN_FILE_PICKER_ROWS, terminalRows - selectedFileRows - promptChromeRows),
  );

  return (
    <Box ref={promptRef} flexDirection="column">
      {selectedAttachmentList}
      <BufferView label={label} text={buf.text} placeholder={label || "Message"} />
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
