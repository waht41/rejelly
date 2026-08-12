/**
 * Full-screen two-stage overlay: ctrl+o opens a tool selector, Enter opens one
 * full tool result transcript. Viewport-sliced with arrow / PgUp / PgDn scrolling.
 * Esc pops one layer (detail → list → closed); ctrl+o closes from anywhere.
 */

import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useMemo, useState } from "react";
import { ListPicker } from "../operator-decision/ListPicker";
import { getVisibleWindow } from "../operator-decision/navigation";
import type { ToolBlock } from "../store/useOutputStore";
import { useOutputStore } from "../store/useOutputStore";
import { useViewStore } from "../store/useViewStore";

type ToolEntry = {
  id: string;
  tool: ToolBlock;
  ordinal: number;
};

/** One viewport line plus how to color it. Each entry is exactly one visual row. */
type RenderLine = { text: string; color?: string; dim?: boolean };

type OverlayMode = "list" | "detail";

function buildToolEntries(
  history: ReturnType<typeof useOutputStore.getState>["history"],
): ToolEntry[] {
  return history
    .filter((turn) => turn.type === "tool")
    .map((turn, index) => ({
      id: turn.id,
      tool: turn.tool,
      ordinal: turn.tool.ordinal ?? index + 1,
    }))
    .reverse();
}

function appendVisualLines(
  target: RenderLine[],
  text: string,
  columns: number,
  style: Pick<RenderLine, "color" | "dim"> = {},
): void {
  const width = Math.max(1, columns);
  const rawLines = text.split("\n");
  for (const rawLine of rawLines) {
    const line = rawLine || " ";
    if (line.length <= width) {
      target.push({ text: line, ...style });
      continue;
    }
    for (let offset = 0; offset < line.length; offset += width) {
      target.push({ text: line.slice(offset, offset + width), ...style });
    }
  }
}

function getDiffLineStyle(line: string): Pick<RenderLine, "color" | "dim"> {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return { color: "green" };
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return { color: "red" };
  }
  if (line.startsWith("@@")) {
    return { color: "cyan" };
  }
  if (line.startsWith("---") || line.startsWith("+++")) {
    return { dim: true };
  }
  return {};
}

function appendFramedDiffLines(target: RenderLine[], diffText: string, columns: number): void {
  const width = Math.max(8, columns);
  const innerWidth = Math.max(1, width - 4);
  const border = "─".repeat(width - 2);
  target.push({ text: `╭${border}╮`, dim: true });
  for (const rawLine of diffText.split("\n")) {
    const line = rawLine || " ";
    const style = getDiffLineStyle(line);
    for (let offset = 0; offset < line.length; offset += innerWidth) {
      const segment = line.slice(offset, offset + innerWidth).padEnd(innerWidth, " ");
      target.push({ text: `│ ${segment} │`, ...style });
    }
  }
  target.push({ text: `╰${border}╯`, dim: true });
}

/** Build rendered lines for one selected tool block. */
function buildDetailLines(entry: ToolEntry, columns: number): RenderLine[] {
  const allLines: RenderLine[] = [];
  allLines.push({
    text: `#${entry.ordinal} ${entry.tool.toolName}`,
    color: entry.tool.ok ? "green" : "red",
  });
  allLines.push({ text: entry.tool.summary, dim: true });
  if (entry.tool.detail?.type === "diff" && entry.tool.detail.text.trim().length > 0) {
    allLines.push({ text: " ", dim: true });
    if (entry.tool.detail.caption) {
      allLines.push({ text: entry.tool.detail.caption, dim: true });
    }
    allLines.push({ text: "Diff", color: "cyan" });
    appendFramedDiffLines(allLines, entry.tool.detail.text, columns);
  } else if (entry.tool.args !== undefined && entry.tool.args.trim().length > 0) {
    allLines.push({ text: " ", dim: true });
    allLines.push({ text: "Arguments", color: "cyan" });
    appendVisualLines(allLines, entry.tool.args, columns, { dim: true });
  }
  allLines.push({ text: "".padEnd(Math.min(columns - 2, 40), "─"), dim: true });
  const contentLines = entry.tool.fullResult.split("\n");
  for (const line of contentLines) {
    appendVisualLines(allLines, line || " ", columns);
  }
  return allLines;
}

const PAGE_SCROLL_FRACTION = 0.8;

export function TranscriptOverlay() {
  const history = useOutputStore((s) => s.history);
  const closeTranscript = useViewStore((s) => s.closeTranscript);
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const columns = stdout?.columns ?? 80;

  const toolEntries = useMemo(() => buildToolEntries(history), [history]);
  const listViewportRows = Math.max(4, rows - 3); // reserve 1 for header + 1 gap + 1 status
  const detailViewportLines = Math.max(4, rows - 3);
  const pageStep = Math.max(1, Math.floor(listViewportRows * PAGE_SCROLL_FRACTION));

  const [mode, setMode] = useState<OverlayMode>("list");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    setSelectedIndex((prev) => Math.min(prev, Math.max(0, toolEntries.length - 1)));
  }, [toolEntries.length]);

  const selectedEntry = toolEntries[selectedIndex];
  const detailLines = useMemo(
    () => (selectedEntry ? buildDetailLines(selectedEntry, columns) : []),
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

  useInput((_input, key) => {
    if (mode !== "detail") {
      return;
    }
    // Esc pops one layer (detail → list, keeping the selection); ctrl+o closes the
    // whole overlay from anywhere, mirroring the key that opened it.
    if (key.escape) {
      setMode("list");
      return;
    }
    if (key.ctrl && _input === "o") {
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
            <Text
              key={safeDetailOffset + i}
              wrap="truncate-end"
              color={line.color}
              dimColor={line.dim}
            >
              {line.text || " "}
            </Text>
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
        <ListPicker
          items={toolEntries}
          getId={(entry) => entry.id}
          navigation="clamp"
          maxVisibleRows={listViewportRows}
          pageStep={pageStep}
          selectedIndex={selectedIndex}
          onSelectedIndexChange={setSelectedIndex}
          isCancelInput={(input, key) => key.ctrl && input === "o"}
          emptyText="No tool calls in this session."
          onCancel={closeTranscript}
          onSelect={(entry) => {
            const index = toolEntries.findIndex((candidate) => candidate.id === entry.id);
            setSelectedIndex(Math.max(0, index));
            setScrollOffset(0);
            setMode("detail");
          }}
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
