/** Renders a unified diff inside Ink with per-line coloring and bounded work. */

import { Box, Text } from "ink";
import {
  collapseDiffContext,
  type DisplayDiffLine,
  layoutDiffLines,
  projectUnifiedDiff,
  summarizeUnifiedDiff,
} from "./diffProjection";
import { DIFF_COLORS } from "./diffTheme";

/** Full diff remains available to its owner; this terminal view only renders a bounded prefix. */
const MAX_RENDER_LINES = 1_200;

function DiffLineContent({ line }: { line: DisplayDiffLine }) {
  return (
    <>
      <Text dimColor>{line.gutter}</Text>
      <Text dimColor={line.continuation}>{line.marker}</Text>
      {line.content}
    </>
  );
}

function DiffLine({ line, index }: { line: DisplayDiffLine; index: number }) {
  const key = `${index}:${line.kind}:${line.text.slice(0, 48)}`;
  if (line.kind === "file") {
    return (
      <Box key={key} marginTop={line.startsFile ? 1 : 0}>
        <Text bold>
          <DiffLineContent line={line} />
        </Text>
      </Box>
    );
  }
  if (line.kind === "addition") {
    return (
      <Text key={key} color={DIFF_COLORS.addition} wrap="hard">
        <DiffLineContent line={line} />
      </Text>
    );
  }
  if (line.kind === "deletion") {
    return (
      <Text key={key} color={DIFF_COLORS.deletion} wrap="hard">
        <DiffLineContent line={line} />
      </Text>
    );
  }
  if (line.kind === "hunk") {
    return (
      <Text key={key} color={DIFF_COLORS.hunk} wrap="hard">
        <DiffLineContent line={line} />
      </Text>
    );
  }
  return (
    <Text
      key={key}
      color={line.kind === "meta" || line.kind === "fold" ? DIFF_COLORS.meta : undefined}
      dimColor={line.kind === "meta" || line.kind === "fold"}
      wrap="hard"
    >
      <DiffLineContent line={line} />
    </Text>
  );
}

export function DiffViewer({ diffText, columns }: { diffText: string; columns: number }) {
  if (!diffText) {
    return null;
  }

  const contentColumns = Math.max(1, columns - 1);
  const allLines = projectUnifiedDiff(diffText);
  const truncated = allLines.length > MAX_RENDER_LINES;
  const logicalLines = truncated ? allLines.slice(0, MAX_RENDER_LINES) : allLines;
  const lines = layoutDiffLines(collapseDiffContext(logicalLines), contentColumns);
  const summary = summarizeUnifiedDiff(diffText);
  const fileLabel = summary.files === 1 ? "file" : "files";

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box>
        <Text bold color={DIFF_COLORS.heading}>
          Changes
        </Text>
        <Text dimColor>{` · ${summary.files} ${fileLabel} · `}</Text>
        <Text color={DIFF_COLORS.addition}>{`+${summary.additions}`}</Text>
        <Text> </Text>
        <Text color={DIFF_COLORS.deletion}>{`−${summary.deletions}`}</Text>
      </Box>
      {lines.map((line, index) => (
        <DiffLine key={`${index}:${line.kind}`} line={line} index={index} />
      ))}
      {truncated ? (
        <Text dimColor>
          … ({allLines.length} lines total; showing first {MAX_RENDER_LINES})
        </Text>
      ) : null}
    </Box>
  );
}
