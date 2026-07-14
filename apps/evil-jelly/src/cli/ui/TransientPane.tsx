import { Box } from "ink";
import type { TransientView } from "../store/usePromptStore";
import { DiffBlock } from "./viewers/DiffViewer";
import { MarkdownViewer } from "./viewers/MarkdownViewer";

export function TransientPane({ view }: { view: TransientView }) {
  if (view.type === "diff") {
    return <DiffBlock text={view.text} caption={view.caption} captionTitle={view.captionTitle} />;
  }
  if (view.type === "markdown") {
    return (
      <Box flexDirection="column" marginBottom={1} paddingX={1}>
        <MarkdownViewer text={view.text} />
      </Box>
    );
  }
  return null;
}
