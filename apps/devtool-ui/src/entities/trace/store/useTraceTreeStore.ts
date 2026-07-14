/**
 * Trace Tree UI Store
 *
 * Manages UI state for the trace tree component:
 * - Expanded/collapsed nodes
 *
 * Using Zustand for state management
 */

import { create } from "zustand";

interface TraceTreeUIState {
  // State
  expandedNodes: Set<string>;

  // Actions
  toggleNode: (nodeId: string) => void;
  setExpandedNodes: (nodes: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  collapseAll: () => void;
  resetUI: () => void;
}

export const useTraceTreeStore = create<TraceTreeUIState>((set) => ({
  expandedNodes: new Set(),

  toggleNode: (nodeId) =>
    set((state) => {
      const next = new Set(state.expandedNodes);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return { expandedNodes: next };
    }),

  setExpandedNodes: (nodes) =>
    set((state) => ({
      expandedNodes: typeof nodes === "function" ? nodes(state.expandedNodes) : nodes,
    })),

  collapseAll: () => set({ expandedNodes: new Set() }),

  resetUI: () => set({ expandedNodes: new Set() }),
}));
