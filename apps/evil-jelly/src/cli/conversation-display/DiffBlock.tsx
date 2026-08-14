/** A reviewed diff with its optional review summary. */

import { Box, Text } from "ink";
import { DiffViewer } from "../terminal-ui/rich-text/DiffViewer";

/**
 * Conversation-level review artifact shared by persistent history and a transient decision view.
 * The caption and its default title carry review semantics; raw diff rendering stays terminal UI.
 */
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
