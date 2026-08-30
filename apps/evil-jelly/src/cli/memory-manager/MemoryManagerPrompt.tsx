import { Box, Text, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useState } from "react";
import wrapAnsi from "wrap-ansi";
import type {
  MemoryManagerAction,
  MemoryManagerEntry,
  MemoryManagerRequest,
} from "../../shared/host/inputBindings";
import { ListViewport } from "../terminal-ui/picker/ListViewport";
import { moveListSelection } from "../terminal-ui/picker/listNavigation";

const VISIBLE_ROWS = 10;
const DETAIL_HORIZONTAL_SAFETY_COLUMNS = 4;

function statusLabel(entry: MemoryManagerEntry): string {
  return entry.injectedStatus === "current"
    ? "current"
    : entry.injectedStatus === "pending_next_epoch"
      ? "pending next epoch"
      : entry.injectedStatus === "removed_next_epoch"
        ? "removed next epoch"
        : "not injected";
}

export function buildMemoryDetailLines(detail: MemoryManagerEntry, columns: number): string[] {
  // Ink/Yoga may reserve a couple more cells than the terminal width reported to this leaf.
  // Leave a small safety gutter so a pre-wrapped line is never truncated a second time.
  const width = Math.max(1, columns - DETAIL_HORIZONTAL_SAFETY_COLUMNS);
  return [
    `ID: ${detail.id}`,
    `Scope: ${detail.scope}`,
    `Summary: ${detail.summary}`,
    `Revision: ${detail.revision}`,
    `Injected: ${statusLabel(detail)}`,
    "Detail:",
    detail.detail,
    `Created: ${detail.createdAt}`,
    `Updated: ${detail.updatedAt}`,
    "Provenance:",
    detail.provenance,
  ].flatMap((value) =>
    value.split("\n").flatMap((line) => {
      if (line.length === 0) return [""];
      return wrapAnsi(line, width, { hard: true, trim: false }).split("\n");
    }),
  );
}

export function MemoryManagerPrompt({
  request,
  onAction,
}: {
  request: MemoryManagerRequest;
  onAction: (action: MemoryManagerAction) => void;
}) {
  const initialIndex = useMemo(
    () =>
      Math.max(
        0,
        request.entries.findIndex((entry) => entry.id === request.selectedId),
      ),
    [request.entries, request.selectedId],
  );
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const [detailLineIndex, setDetailLineIndex] = useState(0);
  const { columns, rows: terminalRows } = useWindowSize();
  const detailViewportLines = Math.max(3, Math.min(12, terminalRows - 12));
  const detailLines = useMemo(() => {
    if (!request.detail) return [];
    return buildMemoryDetailLines(request.detail, columns);
  }, [columns, request.detail]);
  const detailMaxOffset = Math.max(0, detailLines.length - detailViewportLines);
  const safeDetailOffset = Math.min(detailLineIndex, detailMaxOffset);

  useEffect(() => setSelectedIndex(initialIndex), [initialIndex]);
  useEffect(() => setDetailLineIndex(0), [request.detail?.id]);

  useInput((input, key) => {
    const selected = request.detail ?? request.entries[selectedIndex];
    if (input.toLocaleLowerCase() === "o") {
      if (request.canRevealFile && selected) {
        onAction({ action: "reveal_file", id: selected.id });
      }
      return;
    }
    if (request.detail) {
      if (input.toLocaleLowerCase() === "d") {
        onAction({ action: "delete", id: request.detail.id });
        return;
      }
      if (key.escape) {
        onAction({ action: "back" });
        return;
      }
      if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.home || key.end) {
        const pageStep = Math.max(1, detailViewportLines - 1);
        setDetailLineIndex((current) => {
          if (key.home) return 0;
          if (key.end) return detailMaxOffset;
          const delta = key.pageUp ? -pageStep : key.pageDown ? pageStep : key.upArrow ? -1 : 1;
          return Math.max(0, Math.min(detailMaxOffset, current + delta));
        });
        return;
      }
      return;
    }
    if (key.escape) {
      onAction({ action: "close" });
      return;
    }
    if (input.toLocaleLowerCase() === "r") {
      onAction({ action: "refresh" });
      return;
    }
    if (input.toLocaleLowerCase() === "d") {
      const selected = request.entries[selectedIndex];
      if (selected) onAction({ action: "delete", id: selected.id });
      return;
    }
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.home || key.end) {
      const command = key.home
        ? "home"
        : key.end
          ? "end"
          : key.pageDown
            ? "page-down"
            : key.pageUp
              ? "page-up"
              : key.upArrow
                ? "up"
                : "down";
      setSelectedIndex((previous) =>
        moveListSelection({
          selectedIndex: previous,
          itemCount: request.entries.length,
          command,
          mode: key.upArrow || key.downArrow ? "wrap" : undefined,
          pageStep: VISIBLE_ROWS - 1,
        }),
      );
      return;
    }
    if (key.return && selected) onAction({ action: "detail", id: selected.id });
  });

  if (request.detail) {
    const detail = request.detail;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Memory · {detail.title}</Text>
        <Box flexDirection="column" marginTop={1} height={detailViewportLines} overflow="hidden">
          {detailLines
            .slice(safeDetailOffset, safeDetailOffset + detailViewportLines)
            .map((line, index) => (
              <Text key={`${safeDetailOffset + index}:${line}`} wrap="truncate-end">
                {line || " "}
              </Text>
            ))}
        </Box>
        <Text dimColor>
          Lines {safeDetailOffset + 1}–
          {Math.min(detailLines.length, safeDetailOffset + detailViewportLines)} of{" "}
          {detailLines.length} · ↑/↓ scroll · Home/End jump
        </Text>
        {request.canRevealFile ? (
          <Text dimColor>O reveal · D delete · Esc back</Text>
        ) : (
          <Text dimColor>D delete · Esc back</Text>
        )}
        {request.message ? <Text color="green">{request.message}</Text> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Persistent Memory</Text>
      {request.diagnostic ? <Text color="yellow">Warning: {request.diagnostic}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        <ListViewport
          items={request.entries}
          selectedIndex={selectedIndex}
          visibleRows={VISIBLE_ROWS}
          getKey={(entry) => entry.id}
          empty={<Text dimColor>No persistent memory entries.</Text>}
          renderItem={(entry, { selected }) => (
            <Text color={selected ? "cyan" : undefined} bold={selected} wrap="truncate-end">
              {selected ? "▸ " : "  "}[{entry.scope}] {entry.title} — {entry.summary} ·{" "}
              {statusLabel(entry)}
            </Text>
          )}
        />
      </Box>
      {request.message ? <Text color="green">{request.message}</Text> : null}
      <Text dimColor>↑/↓ move · Enter details · O reveal · D delete · R refresh · Esc close</Text>
    </Box>
  );
}
