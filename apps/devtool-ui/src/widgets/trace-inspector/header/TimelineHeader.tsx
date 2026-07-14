/**
 * Timeline Header Component
 *
 * Replaces the xyflow FlowView with a compact horizontal timeline strip
 * Shows generations as colored blocks with duration and status
 */

import { useSelectionStore } from "@shared/store/useSelectionStore";
import { GenericTimelineHeader } from "@widgets/trace-inspector/header/GenericTimelineHeader";
import { getAgentTimelineGenerationItems } from "@widgets/trace-inspector/lib/generationViewModel";
import type { NormalizedTrace } from "src/entities/trace/types";

interface TimelineHeaderProps {
  /** When null (e.g. span detail), shows an empty strip instead of generation blocks. */
  agent: NormalizedTrace.AgentNode | null;
  trace: NormalizedTrace.Trace | null;
}

export function TimelineHeader({ agent, trace }: TimelineHeaderProps) {
  const { generationSelections, selectGeneration } = useSelectionStore();

  if (!agent || !trace) {
    return (
      <div className="h-14 flex items-center justify-center border-b border-border bg-muted/20">
        <div className="text-xs text-muted-foreground">No generation timeline for this node</div>
      </div>
    );
  }

  const selectedGenId = generationSelections[agent.spanId];
  const generations = getAgentTimelineGenerationItems(trace, agent);

  return (
    <GenericTimelineHeader
      generations={generations}
      selectedId={selectedGenId}
      onSelect={(id) => selectGeneration(agent.spanId, id)}
      title="Timeline"
      emptyMessage="No generations available"
    />
  );
}
