/**
 * Detail View Router
 *
 * Dispatches to the appropriate detail container based on activeNodeType.
 * Only reads activeNodeId, activeNodeType, getActiveGenerationId from store;
 * data fetching is delegated to each container.
 * Renders SmartBreadcrumb at top (inside detail panel).
 */

import { AskAIButton } from "@features/command-view";
import { SmartBreadcrumb } from "@features/trace-breadcrumb/SmartBreadcrumb";
import { useSelectionStore } from "@shared/store/useSelectionStore";
import { AgentDetailContainer } from "./agent-detail/AgentDetailContainer";
import { EmptyStateMessage } from "./EmptyStateMessage";
import { RunWithDetailContainer } from "./run-with-detail/RunWithDetailContainer.tsx";
import { SpanDetailContainer } from "./span-detail/SpanDetailContainer.tsx";

export function DetailView() {
  const { activeNodeId, activeNodeType, getActiveGenerationId } = useSelectionStore();
  const selectedGenerationId = getActiveGenerationId();

  const content = !activeNodeId ? (
    <EmptyStateMessage message="Select a node or generation to view details" />
  ) : (
    <>
      {activeNodeType === "span" && <SpanDetailContainer nodeId={activeNodeId} />}
      {activeNodeType === "runWith" && <RunWithDetailContainer nodeId={activeNodeId} />}
      {activeNodeType === "agent" && (
        <AgentDetailContainer nodeId={activeNodeId} generationId={selectedGenerationId} />
      )}
      {activeNodeType !== "span" && activeNodeType !== "runWith" && activeNodeType !== "agent" && (
        <EmptyStateMessage message="Unknown node type" />
      )}
    </>
  );

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-shrink-0 border-b border-border">
        <SmartBreadcrumb trailing={<AskAIButton />} />
      </div>
      <div className="flex-1 min-h-0">{content}</div>
    </div>
  );
}
