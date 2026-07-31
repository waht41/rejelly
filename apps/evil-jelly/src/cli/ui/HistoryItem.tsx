import { Box, Text } from "ink";
import type { Turn } from "../store/useOutputStore";
import { DiffBlock } from "./viewers/DiffViewer";
import { MarkdownViewer } from "./viewers/MarkdownViewer";

const TOOL_PREVIEW_OUTPUT_ROWS = 3;
const TRUNCATION_LINES = new Set(["...", "…"]);

function formatApproxCount(count: number): string {
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

/**
 * How much of the result the preview is holding back.
 *
 * The preview is cut on two axes — at six lines *or* six hundred characters —
 * so a line count alone cannot describe it. One 5000-character line is trimmed
 * hard while omitting no whole line at all, which used to be reported as the
 * self-contradictory "+0 lines".
 */
function describeOmission(shown: string[], fullResult: string): string {
  const trimmedResult = fullResult.trimEnd();
  const fullLineCount = trimmedResult.length > 0 ? trimmedResult.split("\n").length : 0;
  const omittedLines = Math.max(0, fullLineCount - shown.length);
  if (omittedLines > 0) {
    return `+${omittedLines} lines`;
  }
  const omittedChars = Math.max(0, trimmedResult.length - shown.join("\n").length);
  return omittedChars > 0 ? `+${formatApproxCount(omittedChars)} chars` : "";
}

function compactToolPreview(
  preview: string,
  fullResult: string,
  ordinal: number | undefined,
): string[] {
  const rawLines = preview.trimEnd().split("\n");
  const lastLine = rawLines[rawLines.length - 1];
  const alreadyTruncated = lastLine ? TRUNCATION_LINES.has(lastLine.trim()) : false;
  const contentLines = alreadyTruncated ? rawLines.slice(0, -1) : rawLines;
  const shownLines = contentLines.slice(0, TOOL_PREVIEW_OUTPUT_ROWS);
  const omission = describeOmission(shownLines, fullResult);
  const needsTruncation =
    alreadyTruncated || contentLines.length > TOOL_PREVIEW_OUTPUT_ROWS || omission.length > 0;

  if (needsTruncation) {
    const label = [omission, ordinal === undefined ? "" : `#${ordinal}`].filter(Boolean).join(", ");
    return [...shownLines, label.length > 0 ? `… (${label})` : "…"];
  }

  if (contentLines.length === 0 || contentLines[0] === "") {
    return [];
  }

  return contentLines.slice(0, TOOL_PREVIEW_OUTPUT_ROWS);
}

export function HistoryItem({ turn, columns }: { turn: Turn; columns: number }) {
  if (turn.type === "banner") {
    const { model, dir, version } = turn.banner;
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={2}
        marginBottom={1}
        alignSelf="flex-start"
      >
        <Box marginBottom={1}>
          <Text bold color="whiteBright">
            {">_ Evil Jelly"}
          </Text>
          <Text dimColor> (v{version})</Text>
        </Box>
        <Box>
          <Text dimColor>{"model:     "}</Text>
          <Text>{model}</Text>
        </Box>
        <Box>
          <Text dimColor>{"directory: "}</Text>
          <Text>{dir}</Text>
        </Box>
      </Box>
    );
  }
  if (turn.type === "user") {
    return (
      <Box width={columns} paddingX={1} marginBottom={1} backgroundColor="#333">
        <Text bold color="whiteBright">
          ❯ {turn.content}
        </Text>
      </Box>
    );
  }
  if (turn.type === "assistant") {
    if (turn.hidden) {
      return null;
    }
    return (
      <Box paddingBottom={1}>
        <MarkdownViewer text={turn.content} columns={columns} />
      </Box>
    );
  }
  if (turn.type === "assistant_stream") {
    return (
      <Box paddingBottom={turn.final ? 1 : 0}>
        <MarkdownViewer text={turn.content} columns={columns} />
      </Box>
    );
  }
  if (turn.type === "diff") {
    return (
      <Box flexDirection="column" paddingBottom={1}>
        <DiffBlock
          text={turn.diff.text}
          caption={turn.diff.caption}
          captionTitle={turn.diff.captionTitle}
        />
      </Box>
    );
  }
  if (turn.type === "tool") {
    const { summary, preview, fullResult, ok, ordinal } = turn.tool;
    const previewLines = compactToolPreview(preview, fullResult, ordinal);
    return (
      // `<Static>` lays its children out at their content width, not the
      // terminal's, so a truncating child is measured against the full width and
      // then pushed past it by its siblings. Pin the width the way the user turn
      // above already does, or the row overflows and the terminal wraps it.
      <Box flexDirection="column" width={columns}>
        <Box>
          {/* flexShrink={0}: an over-wide headline otherwise makes Yoga squeeze
              the marker instead of truncating the summary, eating its spaces. */}
          <Box flexShrink={0}>
            <Text color={ok ? "green" : "red"}>● </Text>
            {ordinal === undefined ? null : <Text>{`#${ordinal} `}</Text>}
          </Box>
          {/* A headline stays one row. Nothing is lost: `/expand-tool #N`
              reprints the whole summary along with the full result. */}
          <Text wrap="truncate-end">{summary}</Text>
        </Box>
        {previewLines.length > 0 ? (
          <Box flexDirection="column" paddingLeft={2}>
            {previewLines.map((line, index) => (
              // One row per preview line. The block promises "3 lines and then a
              // count"; a 500-char JSON line wrapping into six rows breaks that
              // promise as thoroughly as showing all of them would.
              <Text key={index} dimColor wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    );
  }
  return (
    <Box paddingBottom={1} width={columns}>
      {/* Notices (`[Auto-allowed] …`) are headlines and truncate. Everything else
          — `/expand-tool` output above all — is content and must stay whole. */}
      <Text dimColor wrap={turn.oneLine ? "truncate-end" : "wrap"}>
        {" "}
        {turn.content}
      </Text>
    </Box>
  );
}
