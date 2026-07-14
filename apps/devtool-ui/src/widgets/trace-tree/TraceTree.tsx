/**
 * Trace Tree Component
 *
 * Main component for the trace tree view
 * Handles layout, keyboard events, and state management
 */

import { useCurrentTraceContext } from "@entities/trace/hooks/useCurrentTraceContext";
import { getTraceDisplayName } from "@entities/trace/lib/traceDisplayName";
import { getStructuralChildren } from "@entities/trace/lib/treeFinder";
import { buildFlatTraceTree } from "@entities/trace/lib/treeView";
import { useTraceStore } from "@entities/trace/store";
import { useTraceTreeStore } from "@entities/trace/store/useTraceTreeStore";
import { useTraceFileLoader } from "@features/load-trace/useTraceFileLoader";
import { useTraceAutoSelection } from "@features/select/useTraceAutoSelection";
import { useTraceTreeNavigation } from "@features/select/useTraceTreeNavigation";
import { useSelectionStore } from "@shared/store/useSelectionStore";
import { useSocketStore } from "@shared/store/useSocketStore";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { TraceTreeHeader } from "./TraceTreeHeader";
import { TraceTreeRow } from "./TraceTreeRow";

export function TraceTree() {
  const normalizedTrace = useTraceStore((state) => state.normalizedTrace);
  const currentTraceId = useTraceStore((state) => state.currentTraceId);
  const isConnected = useSocketStore((state) => state.isConnected);
  const reload = useTraceStore((state) => state.reload);

  const { summary: currentSummary, updateSummary } = useCurrentTraceContext(currentTraceId);

  const traceDisplayName = getTraceDisplayName(currentSummary, normalizedTrace?.name);

  // UI state from store
  const expandedNodes = useTraceTreeStore((state) => state.expandedNodes);
  const setExpandedNodes = useTraceTreeStore((state) => state.setExpandedNodes);
  const collapseAll = useTraceTreeStore((state) => state.collapseAll);
  const generationSelections = useSelectionStore((state) => state.generationSelections);

  const flatNodes = useMemo(() => {
    if (!normalizedTrace) {
      return [];
    }
    return buildFlatTraceTree(normalizedTrace, expandedNodes, generationSelections);
  }, [normalizedTrace, expandedNodes, generationSelections]);

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);

  // File actions hook
  const { fileInputRef, handleExportJson, handleOpenLocalFile, handleFileSelect } =
    useTraceFileLoader();

  // Keyboard navigation hook
  const { handleKeyDown } = useTraceTreeNavigation();

  // Auto-selection hook (handles automatic selection when trace loads)
  useTraceAutoSelection(normalizedTrace);

  // Focus trace tree when trace switches
  useEffect(() => {
    if (currentTraceId && normalizedTrace && containerRef.current) {
      // Use setTimeout to ensure DOM is ready after trace switch
      const timer = setTimeout(() => {
        containerRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [currentTraceId, normalizedTrace]);

  // Expand All handler
  const handleExpandAll = useCallback(() => {
    if (!normalizedTrace) return;
    const allNodeIds = new Set<string>();
    const traverse = (nodeId: string) => {
      const node = normalizedTrace.nodeMap[nodeId];
      if (!node) return;
      if (node.type !== "generation" && node.type !== "update") {
        allNodeIds.add(node.spanId);
      }
      const children = getStructuralChildren(normalizedTrace, nodeId);
      children.forEach((child) => {
        traverse(child.spanId);
      });
    };
    normalizedTrace.structuralRootIds.forEach((id) => {
      const n = normalizedTrace.nodeMap[id];
      if (n && n.type !== "generation") traverse(n.spanId);
    });
    setExpandedNodes(allNodeIds);
  }, [normalizedTrace, setExpandedNodes]);

  return (
    <div className="h-full flex flex-col bg-background relative">
      <TraceTreeHeader
        traceId={normalizedTrace?.id}
        traceName={traceDisplayName}
        traceStartTime={normalizedTrace?.startTime}
        isConnected={isConnected}
        isStarred={currentSummary?.isStarred}
        onExportJson={handleExportJson}
        onOpenLocalFile={handleOpenLocalFile}
        onCollapseAll={collapseAll}
        onExpandAll={handleExpandAll}
        onReconnect={reload}
        onUpdateSummary={normalizedTrace ? updateSummary : undefined}
      />

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.jsonl,.ndjson"
        className="hidden"
        onChange={handleFileSelect}
      />

      {!normalizedTrace ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-4">
          <div className="text-sm">No trace loaded</div>
          <button
            onClick={handleOpenLocalFile}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors text-sm font-medium"
          >
            Load Local Trace
          </button>
        </div>
      ) : (
        <div
          ref={containerRef}
          className="flex-1 overflow-auto outline-none"
          tabIndex={0}
          role="tree"
          aria-label="Trace tree navigation"
          onKeyDown={handleKeyDown}
        >
          {flatNodes.map((flat) => (
            <TraceTreeRow key={flat.node.spanId} data={flat} />
          ))}
        </div>
      )}
    </div>
  );
}
