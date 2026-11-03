/**
 * Full-screen two-stage overlay: ctrl+o opens a tool selector, Enter opens one
 * full tool result transcript. Viewport-sliced with arrow / PgUp / PgDn scrolling.
 * Esc pops one layer (detail → list → closed); ctrl+o closes from anywhere.
 */

import { Box, Text, useInput, useWindowSize } from "ink";
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
  const runningTools = useOutputStore((s) => s.runningTools);
  const closeTranscript = useToolTranscriptViewStore((s) => s.closeTranscript);
  const { rows, columns } = useWindowSize();

  const toolEntries = useMemo(
    () => buildToolTranscriptEntries(toolHistory, runningTools),
    [runningTools, toolHistory],
  );
  // Header and footer each occupy one row; the body has a gap on BOTH sides.
  // Drop those gaps in short terminals instead of forcing a minimum body height
  // that pushes the footer off screen. List and detail share the same budget.
  const gapRows = rows >= 6 ? 1 : 0;
  const viewportRows = Math.max(0, rows - 2 - gapRows * 2);
  const pageStep = Math.max(1, Math.floor(viewportRows * PAGE_SCROLL_FRACTION));

  const [mode, setMode] = useState<OverlayMode>("list");
  // Bind the initial row synchronously. Waiting for an effect leaves one render where
  // selection is only "index 0"; opening detail during that window lets a newly
  // completed tool take over the detail pane before the identity is captured.
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(
    () => toolEntries[0]?.id ?? null,
  );
  const [scrollOffset, setScrollOffset] = useState(0);
  const [scrollAnchor, setScrollAnchor] = useState<string | null>(null);

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
  const detailMaxOffset = Math.max(0, detailLines.length - viewportRows);
  const anchoredOffset =
    scrollAnchor === null ? -1 : detailLines.findIndex((line) => line.anchor === scrollAnchor);
  const safeDetailOffset = Math.min(
    anchoredOffset >= 0 ? anchoredOffset : scrollOffset,
    detailMaxOffset,
  );
  const moveDetailTo = (offset: number) => {
    const nextOffset = Math.max(0, Math.min(offset, detailMaxOffset));
    setScrollOffset(nextOffset);
    setScrollAnchor(detailLines[nextOffset]?.anchor ?? null);
  };
  const visibleDetailLines = detailLines.slice(safeDetailOffset, safeDetailOffset + viewportRows);
  const listWindow = getVisibleWindow({
    selectedIndex,
    itemCount: toolEntries.length,
    visibleRowCount: viewportRows,
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
        setScrollAnchor(detailLines[0]?.anchor ?? null);
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
      moveDetailTo(safeDetailOffset - 1);
      return;
    }
    if (key.downArrow) {
      moveDetailTo(safeDetailOffset + 1);
      return;
    }
    if (key.pageUp || (key.shift && key.tab)) {
      moveDetailTo(safeDetailOffset - pageStep);
      return;
    }
    if (key.pageDown) {
      moveDetailTo(safeDetailOffset + pageStep);
      return;
    }
    if (key.home) {
      moveDetailTo(0);
      return;
    }
    if (key.end) {
      moveDetailTo(detailMaxOffset);
      return;
    }
  });

  const showingDetail = mode === "detail" && selectedEntry !== undefined;

  return (
    <Box flexDirection="column" height={rows} width={columns} overflow="hidden">
      <Box height={1} flexShrink={0}>
        <Text wrap="truncate-end">
          <Text bold color="cyan">
            {showingDetail ? "Tool Transcript " : "Tool Calls "}
          </Text>
          <Text dimColor>
            {showingDetail
              ? "(↑↓ pgup/pgdn home/end scroll · Esc back · ctrl+o close)"
              : "(↑↓ pgup/pgdn select · Enter open · Esc/ctrl+o close)"}
          </Text>
        </Text>
      </Box>
      {viewportRows > 0 ? (
        <Box
          flexDirection="column"
          height={viewportRows}
          marginY={gapRows}
          flexShrink={0}
          overflow="hidden"
        >
          {showingDetail ? (
            visibleDetailLines.map((line, i) => (
              <TranscriptLine key={safeDetailOffset + i} line={line} />
            ))
          ) : (
            <ListViewport
              items={toolEntries}
              selectedIndex={selectedIndex}
              getKey={(entry) => entry.id}
              visibleRows={viewportRows}
              empty={<Text dimColor>No tool calls in this session.</Text>}
              renderItem={(entry, { selected }) => (
                <Text wrap="truncate-end" color={selected ? "cyan" : undefined} inverse={selected}>
                  {selected ? "▸ " : "  "}#{entry.ordinal}{" "}
                  {entry.status === "running" ? "…" : entry.ok ? "✓" : "✗"} {entry.toolName} ·{" "}
                  {entry.summary}
                </Text>
              )}
            />
          )}
        </Box>
      ) : null}
      {rows > 1 ? (
        <Box height={1} flexShrink={0}>
          <Text dimColor wrap="truncate-end">
            {showingDetail
              ? `Line ${safeDetailOffset + 1}–${safeDetailOffset + visibleDetailLines.length} of ${detailLines.length}`
              : toolEntries.length > 0
                ? `${selectedIndex + 1} of ${toolEntries.length}${
                    listWindow.aboveCount > 0 ? ` · ${listWindow.aboveCount} newer above` : ""
                  }${listWindow.belowCount > 0 ? ` · ${listWindow.belowCount} older below` : ""}`
                : ""}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
