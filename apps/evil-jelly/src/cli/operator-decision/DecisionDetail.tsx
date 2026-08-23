import { Box, Text, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useState } from "react";
import wrapAnsi from "wrap-ansi";
import type { PromptChoiceView } from "../../shared/host/inputBindings";
import { DiffBlock } from "../conversation-display/DiffBlock";
import { MarkdownViewer } from "../terminal-ui/rich-text/MarkdownViewer";

const TEXT_VIEWPORT_MAX_ROWS = 10;
const TEXT_VIEWPORT_RESERVED_ROWS = 18;

/** Optional context shown above an operator choice while the decision remains active. */
export function DecisionDetail({ view, columns }: { view: PromptChoiceView; columns: number }) {
  const [scrollOffset, setScrollOffset] = useState(0);
  const { rows: terminalRows } = useWindowSize();
  const viewportRows = Math.max(
    1,
    Math.min(TEXT_VIEWPORT_MAX_ROWS, terminalRows - TEXT_VIEWPORT_RESERVED_ROWS),
  );
  const scrollableLines = useMemo(() => {
    if (view.type !== "scrollable_text") return [];
    return wrapAnsi(view.text, Math.max(1, columns - 2), { trim: false, hard: true }).split("\n");
  }, [columns, view]);
  const maxOffset = Math.max(0, scrollableLines.length - viewportRows);
  const safeOffset = Math.min(scrollOffset, maxOffset);

  useEffect(() => setScrollOffset(0), [view]);
  useInput(
    (input, key) => {
      if (view.type !== "scrollable_text") return;
      const scrollKey = input.toLocaleLowerCase();
      if (!(scrollKey === "j" || scrollKey === "k" || key.home || key.end)) return;
      setScrollOffset((current) => {
        if (key.home) return 0;
        if (key.end) return maxOffset;
        return Math.max(0, Math.min(maxOffset, current + (scrollKey === "k" ? -1 : 1)));
      });
    },
    { isActive: view.type === "scrollable_text" && maxOffset > 0 },
  );

  if (view.type === "diff") {
    return <DiffBlock text={view.text} caption={view.caption} captionTitle={view.captionTitle} />;
  }
  if (view.type === "markdown") {
    return (
      <Box flexDirection="column" marginBottom={1} paddingX={1}>
        <MarkdownViewer text={view.text} columns={columns} />
      </Box>
    );
  }
  if (view.type === "scrollable_text") {
    const firstLine = scrollableLines.length === 0 ? 0 : safeOffset + 1;
    const lastLine = Math.min(scrollableLines.length, safeOffset + viewportRows);
    return (
      <Box flexDirection="column" marginBottom={1} paddingX={1}>
        <Text bold>{view.caption ?? "Details"}</Text>
        <Box flexDirection="column" marginTop={1} height={viewportRows} overflow="hidden">
          {scrollableLines.slice(safeOffset, safeOffset + viewportRows).map((line, index) => (
            <Text key={`${safeOffset + index}:${line}`} wrap="truncate-end">
              {line || " "}
            </Text>
          ))}
        </Box>
        <Text dimColor>
          Lines {firstLine}–{lastLine} of {scrollableLines.length}
          {maxOffset > 0 ? " · J/K scroll · Home/End jump" : ""}
        </Text>
      </Box>
    );
  }
  return null;
}
