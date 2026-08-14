/** Renders a unified diff inside Ink with per-line coloring and bounded work. */

import { Box, Text } from "ink";

/** Full diff remains available to its owner; this terminal view only renders a bounded prefix. */
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
