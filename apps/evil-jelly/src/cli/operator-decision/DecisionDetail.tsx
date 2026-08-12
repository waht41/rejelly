import { Box } from "ink";
import type { PromptChoiceView } from "../../shared/host/inputBindings";
import { DiffBlock } from "../conversation-display/DiffBlock";
import { MarkdownViewer } from "../terminal-ui/rich-text/MarkdownViewer";

/** Optional context shown above an operator choice while the decision remains active. */
export function DecisionDetail({ view, columns }: { view: PromptChoiceView; columns: number }) {
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
  return null;
}
