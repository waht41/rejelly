import { Box, Text, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useState } from "react";
import wrapAnsi from "wrap-ansi";
import type {
  SkillManagerAction,
  SkillManagerDetail,
  SkillManagerRequest,
} from "../../shared/host/inputBindings";
import { ListViewport } from "../terminal-ui/picker/ListViewport";
import { moveListSelection } from "../terminal-ui/picker/listNavigation";

const VISIBLE_ROWS = 10;
const DETAIL_VIEWPORT_MAX_ROWS = 12;
const DETAIL_VIEWPORT_RESERVED_ROWS = 12;
const DETAIL_HORIZONTAL_SAFETY_COLUMNS = 4;

export interface SkillDetailVisualLine {
  text: string;
  tone: "blank" | "body" | "muted" | "section";
}

function wrapDetailText({
  text,
  width,
  indent = 0,
  tone = "body",
}: {
  text: string;
  width: number;
  indent?: number;
  tone?: SkillDetailVisualLine["tone"];
}): SkillDetailVisualLine[] {
  const prefix = " ".repeat(indent);
  const contentWidth = Math.max(1, width - indent);
  return text.split("\n").flatMap((sourceLine) => {
    if (sourceLine.length === 0) return [{ text: "", tone }];
    return wrapAnsi(sourceLine, contentWidth, { hard: true, trim: false })
      .split("\n")
      .map((line) => ({ text: `${prefix}${line}`, tone }));
  });
}

export function buildSkillDetailLines(
  detail: SkillManagerDetail,
  columns: number,
): SkillDetailVisualLine[] {
  // Ink/Yoga may reserve a couple more cells than the terminal width reported to this leaf.
  // Leave a small safety gutter so a pre-wrapped line is never truncated a second time.
  const width = Math.max(1, columns - DETAIL_HORIZONTAL_SAFETY_COLUMNS);
  const section = (text: string): SkillDetailVisualLine => ({ text, tone: "section" });
  const blank: SkillDetailVisualLine = { text: "", tone: "blank" };
  const field = (text: string) => wrapDetailText({ text, width, indent: 2 });

  return [
    section("Identity"),
    ...field(`Name: ${detail.name}`),
    ...field(`Qualified name: ${detail.qualifiedName}`),
    ...field(`Scope: ${detail.scope}`),
    blank,
    section("Description"),
    ...wrapDetailText({ text: detail.description, width, indent: 2 }),
    blank,
    section(`Instructions · ${detail.instructionCharacters} characters`),
    // Instructions deliberately remain raw: Markdown punctuation and indentation are data here.
    ...wrapDetailText({ text: detail.instruction, width }),
    blank,
    section("Filesystem"),
    ...field(`Root: ${detail.rootPath}`),
    ...field(`Main: ${detail.mainPath}`),
    ...field(`Path convention: ${detail.pathConvention}`),
    blank,
    section(`Resources · ${detail.resources.length}`),
    ...(detail.resources.length === 0
      ? field("(none)")
      : detail.resources.flatMap((resource) =>
          field(`${resource.path} (${resource.kind}, ${resource.sizeBytes} bytes)`),
        )),
    blank,
    section("Access policy"),
    ...wrapDetailText({
      text: "Locator only; ordinary host permissions still apply.",
      width,
      indent: 2,
      tone: "muted",
    }),
  ];
}

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
    return buildSkillDetailLines(request.detail, columns);
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
              <Text
                key={`${safeDetailOffset + index}:${line.tone}:${line.text}`}
                wrap="truncate-end"
                bold={line.tone === "section"}
                color={line.tone === "section" ? "cyan" : undefined}
                dimColor={line.tone === "muted"}
              >
                {line.text || " "}
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
