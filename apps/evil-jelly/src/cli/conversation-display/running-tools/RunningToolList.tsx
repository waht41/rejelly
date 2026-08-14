import { Box, Text } from "ink";
import type { RunningTool } from "./state";
import { composeToolTailWindow } from "./tailWindow";

const TOOL_TAIL_COLORS = ["cyan", "magenta", "yellow", "blue", "green", "red"] as const;

function toolTailColor(ordinal: number): string {
  return TOOL_TAIL_COLORS[(ordinal - 1) % TOOL_TAIL_COLORS.length] ?? "cyan";
}

/** Headlines for every running tool plus one fairly shared transient output window. */
export function RunningToolList({
  tools,
  maxTailRows,
}: {
  tools: RunningTool[];
  maxTailRows: number;
}) {
  const rows = composeToolTailWindow(tools, maxTailRows);
  const prefixed = new Set(rows.map((row) => row.ordinal)).size > 1;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {tools.map((tool) => (
        <Box key={tool.id}>
          <Box flexShrink={0}>
            <Text color="green">● </Text>
            <Text color={toolTailColor(tool.ordinal)}>#{tool.ordinal} </Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {tool.summary}
            {tool.lineCount > 0
              ? ` (${tool.lineCount} line${tool.lineCount === 1 ? "" : "s"})`
              : ""}
          </Text>
        </Box>
      ))}
      {rows.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {rows.map((row, index) => (
            <Box key={`${row.ordinal}:${index}:${row.text}`}>
              {prefixed ? (
                <Box flexShrink={0}>
                  <Text color={toolTailColor(row.ordinal)}>#{row.ordinal} │ </Text>
                </Box>
              ) : null}
              <Text dimColor wrap="truncate-end">
                {row.text}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
