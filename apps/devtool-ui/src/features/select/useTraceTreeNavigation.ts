/**
 * Trace Tree Navigation Hook
 *
 * Handles keyboard navigation for the trace tree
 * Extracted from TraceTree component to improve separation of concerns
 */

import { getStructuralChildren } from "@entities/trace/lib/treeFinder";
import { buildFlatTraceTree } from "@entities/trace/lib/treeView";
import { useTraceStore } from "@entities/trace/store";
import { useTraceTreeStore } from "@entities/trace/store/useTraceTreeStore";
import { useSelectionStore } from "@shared/store/useSelectionStore";
import type React from "react";
import { useMemo } from "react";
import type { NormalizedTrace } from "src/entities/trace/types";

/**
 * Hook for handling keyboard navigation in trace tree
 * Returns a handler that should be bound to onKeyDown event
 */
export function useTraceTreeNavigation() {
  const normalizedTrace = useTraceStore((state) => state.normalizedTrace);
  const expandedNodes = useTraceTreeStore((state) => state.expandedNodes);
  const toggleNode = useTraceTreeStore((state) => state.toggleNode);

  const activeNodeId = useSelectionStore((state) => state.activeNodeId);
  const setActiveNode = useSelectionStore((state) => state.setActiveNode);
  const generationSelections = useSelectionStore((state) => state.generationSelections);

  const visibleNodes = useMemo(() => {
    if (!normalizedTrace) return [];
    return buildFlatTraceTree(normalizedTrace, expandedNodes, generationSelections).map(
      (f) => f.node,
    );
  }, [normalizedTrace, expandedNodes, generationSelections]);

  const isSelectableNodeType = (
    type: NormalizedTrace.TraceNode["type"],
  ): type is "agent" | "span" | "runWith" => {
    return type === "agent" || type === "span" || type === "runWith";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!activeNodeId) {
      if (visibleNodes.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        const firstNode = visibleNodes[0];
        if (isSelectableNodeType(firstNode.type)) {
          setActiveNode(firstNode.spanId, firstNode.type);
        }
      }
      return;
    }

    const currentIndex = visibleNodes.findIndex((node) => node.spanId === activeNodeId);
    if (currentIndex === -1) return;

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        if (currentIndex < visibleNodes.length - 1) {
          const nextNode = visibleNodes[currentIndex + 1];
          if (isSelectableNodeType(nextNode.type)) {
            setActiveNode(nextNode.spanId, nextNode.type);
          }
        }
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        if (currentIndex > 0) {
          const prevNode = visibleNodes[currentIndex - 1];
          if (isSelectableNodeType(prevNode.type)) {
            setActiveNode(prevNode.spanId, prevNode.type);
          }
        }
        break;
      }
      case "ArrowRight": {
        e.preventDefault();
        const currentNode = visibleNodes[currentIndex];
        if (!expandedNodes.has(currentNode.spanId)) {
          toggleNode(currentNode.spanId);
        } else {
          if (!normalizedTrace) break;
          const children = getStructuralChildren(normalizedTrace, currentNode.spanId);
          if (children.length > 0) {
            const firstChild = children[0];
            if (isSelectableNodeType(firstChild.type)) {
              setActiveNode(firstChild.spanId, firstChild.type);
            }
          }
        }
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        const currentNode = visibleNodes[currentIndex];
        if (expandedNodes.has(currentNode.spanId)) {
          toggleNode(currentNode.spanId);
        } else {
          if (!normalizedTrace) break;
          for (let i = currentIndex - 1; i >= 0; i--) {
            const potentialParent = visibleNodes[i];
            const children = getStructuralChildren(normalizedTrace, potentialParent.spanId);
            if (children.some((child) => child.spanId === currentNode.spanId)) {
              if (isSelectableNodeType(potentialParent.type)) {
                setActiveNode(potentialParent.spanId, potentialParent.type);
              }
              break;
            }
          }
        }
        break;
      }
    }
  };

  return { handleKeyDown };
}
