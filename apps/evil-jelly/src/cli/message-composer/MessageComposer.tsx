/**
 * Line input backed by a single text buffer + caret (see ./editor/document/textBuffer), so
 * single- and multi-line editing share one model with full caret movement
 * (←/→, ↑/↓, Home/End, word-jump) and editing (backspace, word/line delete).
 *
 * Submit: Enter submits. Insert a newline with Alt+Enter / Shift+Enter (where
 * the terminal sends them) or by ending the line with a backslash before Enter.
 * Short pasted text keeps its own newlines, so a pasted block never submits early.
 * Long pasted text is stored in a semantic paste token and rendered as a
 * compact `[Pasted text +X lines]` label while the full body stays in the semantic document.
 *
 * @-trigger: typing @ opens a fuzzy file picker; selecting a file inserts an
 * semantic file token at the caret and adds its path to this turn.
 *
 * $-trigger: typing $ opens the Skill/MCP/Memory reference picker; selecting one inserts a semantic
 * token whose display name is qualified only when the combined catalog is ambiguous.
 *
 * Clipboard image: Alt+V (or Ctrl+V, which arrives as garbage bytes and is
 * detected) attaches an image from the OS clipboard. It drops an `[Image #N]`
 * token into the line at the caret. The token is one logical editing unit;
 * deleting it drops the image from the submitted turn.
 *
 * Rendering: the prompt soft-wraps the buffer itself (see
 * ./editor/softWrap) rather than handing Ink a long line to wrap.
 * The caret is a terminal cell, so it has to be placed in *physical* rows and
 * columns; owning the wrap is what lets the painted rows and the caret's
 * position come from one list instead of two guesses that drift apart.
 */

import { Box, Text, useStdout } from "ink";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  MAX_EXPLICIT_MEMORY_REFERENCES,
  promptDocumentCommandText,
} from "../../shared/model/prompt/promptDocument";
import { startupTimeline } from "../../shared/profile/startup/timeline";
import { BufferView } from "./editor/BufferView";
import { useLineKeybindings } from "./editor/keyboard/useLineKeybindings";
import { usePromptLayout } from "./editor/usePromptLayout";
import { MAX_SELECTED_SKILLS } from "./session/composerSession";
import type { ComposerPickerKeyHandler } from "./suggestions/ComposerPicker";
import { ComposerSuggestionOverlay } from "./suggestions/ComposerSuggestionOverlay";
import { useCommandSuggestion } from "./suggestions/commands/useCommandSuggestion";
import { useFileReferenceSuggestion } from "./suggestions/file-reference/useFileReferenceSuggestion";
import {
  mcpReferenceName,
  memoryReferenceName,
  selectedSkillReferenceName,
} from "./suggestions/semantic-reference/referenceNaming";
import { useReferenceSuggestion } from "./suggestions/semantic-reference/useReferenceSuggestion";
import { useComposerDraft } from "./useComposerDraft";

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
  const [terminalRows, setTerminalRows] = useState(stdout.rows || 24);
  const [clipboardImageStatus, setClipboardImageStatus] = useState<string | null>(null);
  const draft = useComposerDraft({ label, onCommand });
  const {
    buffer: buf,
    selectedFiles,
    selectedSkills,
    selectedMcpServers,
    selectedMemories,
    availableSkills,
    availableMcpServers,
    availableMemories,
  } = draft;
  // Key-claim slot shared with whichever picker overlay is mounted: the picker
  // publishes its handler here and the line keybindings offer it each key first.
  const overlayKeysRef = useRef<ComposerPickerKeyHandler | null>(null);

  useLayoutEffect(() => {
    startupTimeline.mark("composer_mounted");
  }, []);

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
    setClipboardImageStatus(null);
    draft.clear();
  };

  const submitCommand = (text: string) => {
    setClipboardImageStatus(null);
    draft.submitCommand(text);
  };

  const commandText = promptDocumentCommandText(buf.document);
  const commandSuggestion = useCommandSuggestion({
    text: commandText ?? "",
    cursor: commandText === undefined ? 0 : buf.cursor,
    isMultiline: commandText === undefined || isMultiline,
    onSelect: submitCommand,
  });
  const fileSuggestion = useFileReferenceSuggestion({
    buffer: buf,
    attachFile: draft.attachFile,
  });
  const referenceSuggestion = useReferenceSuggestion({
    buffer: buf,
    availableSkills,
    availableMcpServers,
    availableMemories,
    selectedSkills,
    selectedMemories,
    maxSelectedSkills: MAX_SELECTED_SKILLS,
    maxSelectedMemories: MAX_EXPLICIT_MEMORY_REFERENCES,
    onNotice,
  });

  // Clipboard status is not part of the draft hook, but follows prompt identity.
  useEffect(() => {
    setClipboardImageStatus(null);
  }, [label]);

  const submit = () => {
    setClipboardImageStatus(null);
    draft.submit();
  };

  const attachClipboardImage = () => {
    setClipboardImageStatus("Reading clipboard image...");
    void readClipboardImage().then((result) => {
      if (result.ok) {
        draft.attachImage(result.path);
        setClipboardImageStatus(null);
        return;
      }
      setClipboardImageStatus(result.message);
    });
  };

  const handleTextPaste = (text: string): boolean => {
    setClipboardImageStatus(null);
    return draft.handleTextPaste(text);
  };

  useLineKeybindings({
    buf,
    wrappedRows: promptLayout.rows,
    overlayKeys: overlayKeysRef,
    isAgentRunning,
    hasInterruptibleTask,
    onInterrupt,
    onCycleMode,
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
        {selectedFiles.map((file, index) => (
          <Box key={`${file}:${index}`} flexDirection="row">
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
            <Text>{selectedSkillReferenceName(skill, availableSkills, availableMcpServers)}</Text>
          </Box>
        ))}
      </Box>
    ) : null;

  const selectedMcpList =
    selectedMcpServers.length > 0 ? (
      <Box flexDirection="column" marginBottom={1}>
        {selectedMcpServers.map((server) => (
          <Box key={server.serverId} flexDirection="row">
            <Text color="cyan">$ </Text>
            <Text>{mcpReferenceName(server, availableSkills)}</Text>
          </Box>
        ))}
      </Box>
    ) : null;

  const selectedMemoryList =
    selectedMemories.length > 0 ? (
      <Box flexDirection="column" marginBottom={1}>
        {selectedMemories.map((memory) => (
          <Box key={memory.memoryId} flexDirection="row">
            <Text color="yellow">$ </Text>
            <Text>
              {memoryReferenceName(memory, availableMemories, availableSkills, availableMcpServers)}
            </Text>
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
    (selectedMcpServers.length > 0 ? selectedMcpServers.length + 1 : 0) +
    (selectedMemories.length > 0 ? selectedMemories.length + 1 : 0) +
    promptLayout.rows.length;
  const suggestionVisibleRows = Math.min(
    MAX_SUGGESTION_ROWS,
    Math.max(MIN_SUGGESTION_ROWS, terminalRows - promptRows - promptChromeRows),
  );

  return (
    <Box flexDirection="column">
      {selectedAttachmentList}
      {selectedSkillList}
      {selectedMcpList}
      {selectedMemoryList}
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
      ) : draft.hasCollapsedPaste ? (
        <Box marginTop={1}>
          <Text dimColor>paste again to expand</Text>
        </Box>
      ) : null}
      <ComposerSuggestionOverlay
        command={commandSuggestion}
        reference={referenceSuggestion}
        file={fileSuggestion}
        availableSkills={availableSkills}
        availableMcpServers={availableMcpServers}
        availableMemories={availableMemories}
        visibleRows={suggestionVisibleRows}
        keySink={overlayKeysRef}
      />
    </Box>
  );
}
