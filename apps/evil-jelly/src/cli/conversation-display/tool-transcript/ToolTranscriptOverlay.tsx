/**
 * Full-screen two-stage overlay: ctrl+o opens a tool selector, Enter opens one
 * full tool result transcript. Viewport-sliced with arrow / PgUp / PgDn scrolling.
 * Esc pops one layer (detail → list → closed); ctrl+o closes from anywhere.
 */

import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useMemo, useState } from "react";
import { ListViewport } from "../../terminal-ui/picker/ListViewport";
import { getVisibleWindow, moveListSelection } from "../../terminal-ui/picker/listNavigation";
import { useOutputStore } from "../useOutputStore";
import type { ToolTranscriptRenderLine } from "./projection";
import {
  buildToolTranscriptDetailLines,
  buildToolTranscriptEntries,
  findToolTranscriptEntryIndex,
} from "./projection";
import { useToolTranscriptViewStore } from "./viewStore";

type OverlayMode = "list" | "detail";

const PAGE_SCROLL_FRACTION = 0.8;

function TranscriptLine({ line }: { line: ToolTranscriptRenderLine }) {
  if (line.content === undefined) {
    return (
      <Text wrap="truncate-end" color={line.color} dimColor={line.dim}>
        {line.text || " "}
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{line.gutter}</Text>
      <Text color={line.color} dimColor={line.continuation}>
        {line.marker}
      </Text>
      <Text color={line.color} dimColor={line.dim}>
        {line.content || " "}
      </Text>
    </Text>
  );
}

export function ToolTranscriptOverlay() {
  const toolHistory = useOutputStore((s) => s.toolHistory);
  const closeTranscript = useToolTranscriptViewStore((s) => s.closeTranscript);
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const columns = stdout?.columns ?? 80;

  const toolEntries = useMemo(() => buildToolTranscriptEntries(toolHistory), [toolHistory]);
  const listViewportRows = Math.max(4, rows - 3); // reserve 1 for header + 1 gap + 1 status
  const detailViewportLines = Math.max(4, rows - 3);
  const pageStep = Math.max(1, Math.floor(listViewportRows * PAGE_SCROLL_FRACTION));

  const [mode, setMode] = useState<OverlayMode>("list");
  // Bind the initial row synchronously. Waiting for an effect leaves one render where
  // selection is only "index 0"; opening detail during that window lets a newly
  // completed tool take over the detail pane before the identity is captured.
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(
    () => toolEntries[0]?.id ?? null,
  );
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    setSelectedEntryId((current) => {
      if (toolEntries.length === 0) {
        return null;
      }
      return current && toolEntries.some((entry) => entry.id === current)
        ? current
        : toolEntries[0]!.id;
    });
  }, [toolEntries]);

  const selectedIndex = findToolTranscriptEntryIndex(toolEntries, selectedEntryId);
  const selectedEntry = toolEntries[selectedIndex];
  const detailLines = useMemo(
    () => (selectedEntry ? buildToolTranscriptDetailLines(selectedEntry, columns) : []),
    [columns, selectedEntry],
  );
  const detailMaxOffset = Math.max(0, detailLines.length - detailViewportLines);
  const safeDetailOffset = Math.min(scrollOffset, detailMaxOffset);
  const visibleDetailLines = detailLines.slice(
    safeDetailOffset,
    safeDetailOffset + detailViewportLines,
  );
  const listWindow = getVisibleWindow({
    selectedIndex,
    itemCount: toolEntries.length,
    visibleRowCount: listViewportRows,
  });

  useInput((input, key) => {
    if (mode === "list") {
      if (key.escape || (key.ctrl && input === "o")) {
        closeTranscript();
        return;
      }
      if (key.upArrow || key.downArrow) {
        const nextIndex = moveListSelection({
          selectedIndex,
          itemCount: toolEntries.length,
          command: key.upArrow ? "up" : "down",
        });
        setSelectedEntryId(toolEntries[nextIndex]?.id ?? null);
        return;
      }
      if (key.pageUp || (key.shift && key.tab) || key.pageDown || key.home || key.end) {
        const command = key.home
          ? "home"
          : key.end
            ? "end"
            : key.pageDown
              ? "page-down"
              : "page-up";
        const nextIndex = moveListSelection({
          selectedIndex,
          itemCount: toolEntries.length,
          command,
          pageStep,
        });
        setSelectedEntryId(toolEntries[nextIndex]?.id ?? null);
        return;
      }
      if (key.return && selectedEntry) {
        setScrollOffset(0);
        setMode("detail");
      }
      return;
    }
    // Esc pops one layer (detail → list, keeping the selection); ctrl+o closes the
    // whole overlay from anywhere, mirroring the key that opened it.
    if (key.escape) {
      setMode("list");
      return;
    }
    if (key.ctrl && input === "o") {
      closeTranscript();
      return;
    }

    if (key.upArrow) {
      setScrollOffset((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setScrollOffset((prev) => Math.min(detailMaxOffset, prev + 1));
      return;
    }
    if (key.pageUp || (key.shift && key.tab)) {
      const detailPageStep = Math.max(1, Math.floor(detailViewportLines * PAGE_SCROLL_FRACTION));
      setScrollOffset((prev) => Math.max(0, prev - detailPageStep));
      return;
    }
    if (key.pageDown) {
      const detailPageStep = Math.max(1, Math.floor(detailViewportLines * PAGE_SCROLL_FRACTION));
      setScrollOffset((prev) => Math.min(detailMaxOffset, prev + detailPageStep));
      return;
    }
    if (key.home) {
      setScrollOffset(0);
      return;
    }
    if (key.end) {
      setScrollOffset(detailMaxOffset);
      return;
    }
  });

  if (mode === "detail" && selectedEntry) {
    return (
      <Box flexDirection="column" height={rows} width={columns}>
        <Box>
          <Text bold color="cyan">
            Tool Transcript{" "}
          </Text>
          <Text dimColor>(↑↓ pgup/pgdn home/end scroll · Esc back · ctrl+o close)</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {visibleDetailLines.map((line, i) => (
            <TranscriptLine key={safeDetailOffset + i} line={line} />
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            Line {safeDetailOffset + 1}–{safeDetailOffset + visibleDetailLines.length} of{" "}
            {detailLines.length}
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Box>
        <Text bold color="cyan">
          Tool Calls{" "}
        </Text>
        <Text dimColor>(↑↓ pgup/pgdn select · Enter open · Esc/ctrl+o close)</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <ListViewport
          items={toolEntries}
          selectedIndex={selectedIndex}
          getKey={(entry) => entry.id}
          visibleRows={listViewportRows}
          empty={<Text dimColor>No tool calls in this session.</Text>}
          renderItem={(entry, { selected }) => {
            return (
              <Text wrap="truncate-end" color={selected ? "cyan" : undefined} inverse={selected}>
                {selected ? "▸ " : "  "}#{entry.ordinal} {entry.tool.ok ? "✓" : "✗"}{" "}
                {entry.tool.toolName} · {entry.tool.summary}
              </Text>
            );
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {toolEntries.length > 0
            ? `${selectedIndex + 1} of ${toolEntries.length}${
                listWindow.aboveCount > 0 ? ` · ${listWindow.aboveCount} newer above` : ""
              }${listWindow.belowCount > 0 ? ` · ${listWindow.belowCount} older below` : ""}`
            : ""}
        </Text>
      </Box>
    </Box>
  );
}
