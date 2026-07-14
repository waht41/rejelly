/**
 * Agent host + optional selected generation from NormalizedTrace (no legacy adapter).
 */

import { findGenerationNodeByHostAndId } from "@entities/trace/lib/treeFinder";
import { useMemo } from "react";
import type { NormalizedTrace } from "src/entities/trace/types";

export interface AgentGenerationDetailModel {
  trace: NormalizedTrace.Trace;
  agent: NormalizedTrace.AgentNode;
  /** Set when generationId points to an existing generation under the agent host. */
  generation: NormalizedTrace.GenerationNode | null;
}

export function useGenerationViewModel(
  normalizedTrace: NormalizedTrace.Trace | null,
  nodeId: string,
  generationId: number | null,
): AgentGenerationDetailModel | null {
  return useMemo(() => {
    if (!normalizedTrace) {
      return null;
    }
    const raw = normalizedTrace.nodeMap[nodeId];
    if (!raw || raw.type !== "agent") {
      return null;
    }
    const normAgent = raw as NormalizedTrace.AgentNode;

    if (generationId == null) {
      return { trace: normalizedTrace, agent: normAgent, generation: null };
    }

    const normGen = findGenerationNodeByHostAndId(normalizedTrace, nodeId, generationId);
    if (!normGen || normGen.type !== "generation") {
      return { trace: normalizedTrace, agent: normAgent, generation: null };
    }

    return { trace: normalizedTrace, agent: normAgent, generation: normGen };
  }, [normalizedTrace, nodeId, generationId]);
}
