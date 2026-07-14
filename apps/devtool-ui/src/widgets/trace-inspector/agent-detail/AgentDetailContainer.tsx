/**
 * Container for Agent detail view. Agent + generation use NormalizedTrace node shapes.
 */

import { useTraceStore } from "@entities/trace/store";
import { TimelineHeader } from "@widgets/trace-inspector/header/TimelineHeader";
import { EmptyStateMessage } from "../EmptyStateMessage";
import { GenerationDetailView } from "./generation-detail";
import { useGenerationViewModel } from "./useGenerationViewModel";

interface AgentDetailContainerProps {
  nodeId: string;
  generationId: number | null;
}

export function AgentDetailContainer({ nodeId, generationId }: AgentDetailContainerProps) {
  const normalizedTrace = useTraceStore((state) => state.normalizedTrace);
  const model = useGenerationViewModel(normalizedTrace, nodeId, generationId);

  if (!model) {
    return null;
  }

  const { trace, agent, generation } = model;

  if (generation) {
    return (
      <div className="h-full flex flex-col">
        <TimelineHeader agent={agent} trace={trace} />
        <div className="flex-1 min-h-0">
          <GenerationDetailView
            trace={trace}
            hostSpanId={nodeId}
            agent={agent}
            generation={generation}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <TimelineHeader agent={agent} trace={trace} />
      <div className="flex-1 min-h-0">
        <EmptyStateMessage
          message={
            generationId != null ? "Generation not found" : "Select a generation to view details"
          }
        />
      </div>
    </div>
  );
}
