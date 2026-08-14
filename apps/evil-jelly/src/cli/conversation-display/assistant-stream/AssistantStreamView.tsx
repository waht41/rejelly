import { Box, Text } from "ink";
import { useMemo } from "react";
import { StreamMarkdownViewer } from "../../terminal-ui/rich-text/MarkdownViewer";
import { createStreamTailWindow } from "../../terminal-ui/rich-text/streamWindow";

export function AssistantStreamView({
  text,
  columns,
  maxRows,
  visible,
}: {
  text: string;
  columns: number;
  maxRows: number;
  visible: boolean;
}) {
  const window = useMemo(
    () => createStreamTailWindow({ text, columns, maxRows }),
    [columns, maxRows, text],
  );

  if (!visible || window.text.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {window.forceRaw ? (
        <Text>{window.text}</Text>
      ) : (
        <StreamMarkdownViewer text={window.text} columns={columns} />
      )}
    </Box>
  );
}
