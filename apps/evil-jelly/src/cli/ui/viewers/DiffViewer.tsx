/**
 * Renders a unified diff inside Ink with per-line coloring (history turns and transient UI).
 */

import { Box, Text } from "ink";

/** Optional caption ("AI merge summary") above a colored diff — shared by history and transient views. */
export function DiffBlock({
  text,
  caption,
  captionTitle,
}: {
  text: string;
  caption?: string;
  captionTitle?: string;
}) {
  return (
    <Box flexDirection="column">
      {caption ? (
        <Box flexDirection="column" marginBottom={1} paddingX={1}>
          <Text bold color="cyan">
            {captionTitle ?? "AI merge summary"}
          </Text>
          <Text wrap="wrap">{caption}</Text>
        </Box>
      ) : null}
      <DiffViewer diffText={text} />
    </Box>
  );
}

/** Bound Ink work when patches are huge; full diff is still passed for the decision, we only render a prefix. */
const MAX_RENDER_LINES = 1_200;

export function DiffViewer({ diffText }: { diffText: string }) {
  if (!diffText) {
    return null;
  }

  const rawLines = diffText.split("\n");
  const truncated = rawLines.length > MAX_RENDER_LINES;
  const lines = truncated ? rawLines.slice(0, MAX_RENDER_LINES) : rawLines;

  return (
    <Box flexDirection="column" paddingY={1} paddingX={2} borderStyle="round" borderColor="gray">
      {lines.map((line, index) => {
        const key = `${index}:${line.slice(0, 48)}`;
        if (line.startsWith("+") && !line.startsWith("+++")) {
          return (
            <Text key={key} color="green">
              {line}
            </Text>
          );
        }
        if (line.startsWith("-") && !line.startsWith("---")) {
          return (
            <Text key={key} color="red">
              {line}
            </Text>
          );
        }
        if (line.startsWith("@@")) {
          return (
            <Text key={key} color="cyan">
              {line}
            </Text>
          );
        }
        const header = line.startsWith("---") || line.startsWith("+++");
        return (
          <Text key={key} dimColor={header}>
            {line}
          </Text>
        );
      })}
      {truncated ? (
        <Text dimColor>
          … ({rawLines.length} lines total; showing first {MAX_RENDER_LINES})
        </Text>
      ) : null}
    </Box>
  );
}
