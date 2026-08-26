import { Box, Text, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useState } from "react";
import wrapAnsi from "wrap-ansi";
import type { SkillManagerAction, SkillManagerRequest } from "../../shared/host/inputBindings";
import { ListViewport } from "../terminal-ui/picker/ListViewport";
import { moveListSelection } from "../terminal-ui/picker/listNavigation";

const VISIBLE_ROWS = 10;
const DETAIL_VIEWPORT_MAX_ROWS = 12;
const DETAIL_VIEWPORT_RESERVED_ROWS = 12;
const DETAIL_HORIZONTAL_SAFETY_COLUMNS = 4;

export function SkillManagerPrompt({
  request,
  onAction,
}: {
  request: SkillManagerRequest;
  onAction: (action: SkillManagerAction) => void;
}) {
  const initialIndex = useMemo(
    () =>
      Math.max(
        0,
        request.entries.findIndex((entry) => entry.qualifiedName === request.selectedQualifiedName),
      ),
    [request.entries, request.selectedQualifiedName],
  );
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const [detailLineIndex, setDetailLineIndex] = useState(0);
  const { columns, rows: terminalRows } = useWindowSize();
  const detailViewportLines = Math.max(
    3,
    Math.min(DETAIL_VIEWPORT_MAX_ROWS, terminalRows - DETAIL_VIEWPORT_RESERVED_ROWS),
  );
  const detailLines = useMemo(() => {
    if (!request.detail) return [];
    const detail = request.detail;
    const logicalLines = [
      `Qualified name: ${detail.qualifiedName}`,
      `Scope: ${detail.scope}`,
      `Description: ${detail.description}`,
      `Instructions (${detail.instructionCharacters} characters):`,
      ...detail.instruction.split("\n"),
      `Root: ${detail.rootPath}`,
      `Main: ${detail.mainPath}`,
      `Path convention: ${detail.pathConvention}`,
      `Resources (${detail.resources.length}):`,
      ...(detail.resources.length === 0
        ? ["- (none)"]
        : detail.resources.map(
            (resource) => `- ${resource.path} (${resource.kind}, ${resource.sizeBytes} bytes)`,
          )),
      "Access policy: locator only; ordinary host permissions still apply.",
    ];
    // Ink/Yoga may reserve a couple more cells than the terminal width reported to this leaf.
    // Leave a small safety gutter so a pre-wrapped line is never truncated a second time.
    return wrapAnsi(
      logicalLines.join("\n"),
      Math.max(1, columns - DETAIL_HORIZONTAL_SAFETY_COLUMNS),
      {
        hard: true,
        trim: false,
      },
    ).split("\n");
  }, [columns, request.detail]);
  const detailMaxOffset = Math.max(0, detailLines.length - detailViewportLines);
  const safeDetailOffset = Math.min(detailLineIndex, detailMaxOffset);

  useEffect(() => setSelectedIndex(initialIndex), [initialIndex]);
  useEffect(() => setDetailLineIndex(0), [request.detail?.qualifiedName]);

  useInput((input, key) => {
    if (request.detail) {
      if (input.toLocaleLowerCase() === "o" && request.canOpenFolder) {
        onAction({ action: "open_folder", qualifiedName: request.detail.qualifiedName });
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
      }
      return;
    }
    if (key.escape) {
      onAction({ action: "close" });
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
    const selected = request.entries[selectedIndex];
    if (key.return && selected) {
      onAction({ action: "detail", qualifiedName: selected.qualifiedName });
    }
  });

  if (request.detail) {
    const detail = request.detail;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Skill · {detail.name}</Text>
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
        <Text dimColor>{request.canOpenFolder ? "O open folder · " : ""}Esc back</Text>
        {request.message ? <Text color="green">{request.message}</Text> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Local Skills</Text>
      <Box flexDirection="column" marginTop={1}>
        <ListViewport
          items={request.entries}
          selectedIndex={selectedIndex}
          visibleRows={VISIBLE_ROWS}
          getKey={(entry) => entry.qualifiedName}
          empty={<Text dimColor>No local Skills enabled in this session.</Text>}
          renderItem={(entry, { selected }) => (
            <Text color={selected ? "cyan" : undefined} bold={selected} wrap="truncate-end">
              {selected ? "▸ " : "  "}[{entry.scope}] {entry.name} —{" "}
              {entry.shortDescription ?? entry.description} · {entry.resourceCount} resources
            </Text>
          )}
        />
      </Box>
      <Text dimColor>↑/↓ move · Enter details · Esc close</Text>
    </Box>
  );
}
