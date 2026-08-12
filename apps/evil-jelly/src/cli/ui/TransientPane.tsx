import { Box } from "ink";
import type { DecisionView } from "../operator-decision/model";
import { DiffBlock } from "./viewers/DiffViewer";
import { MarkdownViewer } from "./viewers/MarkdownViewer";

export function TransientPane({ view, columns }: { view: DecisionView; columns: number }) {
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
