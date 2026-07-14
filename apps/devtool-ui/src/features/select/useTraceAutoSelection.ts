/**
 * Trace Auto Selection Hook
 *
 * Handles automatic selection and expansion when trace loads
 * Extracted from TraceTree component to improve separation of concerns
 */

import { getGenerationsForHost, getStructuralChildren } from "@entities/trace/lib/treeFinder";
import { useTraceTreeStore } from "@entities/trace/store/useTraceTreeStore";
import { useSelectionStore } from "@shared/store/useSelectionStore";
import { useEffect } from "react";
import type { NormalizedTrace } from "src/entities/trace/types";

/**
 * Hook for automatic selection when normalized trace loads
 */
export function useTraceAutoSelection(normalizedTrace: NormalizedTrace.Trace | null) {
  const activeNodeId = useSelectionStore((state) => state.activeNodeId);
  const setActiveNode = useSelectionStore((state) => state.setActiveNode);
  const selectGeneration = useSelectionStore((state) => state.selectGeneration);
  const setExpandedNodes = useTraceTreeStore((state) => state.setExpandedNodes);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Only trigger when trace ID changes to avoid streaming updates
  useEffect(() => {
    if (!normalizedTrace) {
      return;
    }

    const selectedNodeBelongsToTrace = activeNodeId && normalizedTrace.nodeMap[activeNodeId];

    if (activeNodeId && selectedNodeBelongsToTrace) {
      return;
    }

    const rootNodes = normalizedTrace.structuralRootIds
      .map((id) => normalizedTrace.nodeMap[id])
      .filter(Boolean);

    const runWithNode = rootNodes.find((node) => node?.type === "runWith");

    if (runWithNode) {
      const nodesToExpand = new Set<string>([runWithNode.spanId]);
      const runWithChildren = getStructuralChildren(normalizedTrace, runWithNode.spanId);
      if (runWithChildren.length === 1) {
        nodesToExpand.add(runWithChildren[0].spanId);
      }

      setExpandedNodes((prev) => new Set([...prev, ...nodesToExpand]));
      setActiveNode(runWithNode.spanId, "runWith");
    } else {
      const firstAgent = rootNodes.find((node) => node?.type === "agent");
      if (!firstAgent) {
        return;
      }

      setExpandedNodes((prev) => new Set([...prev, firstAgent.spanId]));
      setActiveNode(firstAgent.spanId, "agent");

      const gens = getGenerationsForHost(normalizedTrace, firstAgent.spanId);
      if (gens.length > 0) {
        selectGeneration(firstAgent.spanId, gens[0].startEvent.generationId);
      }
    }
  }, [normalizedTrace?.id, activeNodeId, setActiveNode, selectGeneration, setExpandedNodes]);
}
