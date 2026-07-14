/**
 * Selection store for managing selected agent and generation
 *
 * Uses Zustand for state management
 *
 * Design: "Active Node + Generation Map" - remembers generation selection for each agent
 * This provides "sticky state" behavior: when you switch between agents,
 * each agent remembers which generation you were viewing.
 */

import { create } from "zustand";

// Type aliases for readability
type NodeId = string;
type GenerationId = number;

interface SelectionState {
  // =========================================
  // 1. Global Focus (Focus)
  // =========================================
  /** Current highlighted node ID in left Tree View */
  activeNodeId: NodeId | null;

  /** Current node type (optional, helps with UI rendering) */
  activeNodeType: "agent" | "span" | "generation" | "runWith" | null;

  // =========================================
  // 2. State Memory (Sticky Memory)
  // =========================================
  /**
   * Core design: Records the selected Generation for each Agent.
   * Key: Agent node ID (spanId)
   * Value: Generation ID (1, 2, 3...)
   *
   * When you switch back to an agent, the UI knows which generation to restore.
   */
  generationSelections: Record<NodeId, GenerationId>;

  // =========================================
  // Actions
  // =========================================
  /** Switch left sidebar node */
  setActiveNode: (nodeId: NodeId | null, type?: "agent" | "span" | "runWith" | null) => void;

  /** Select a specific Generation for a node (clicked in Flow View) */
  selectGeneration: (nodeId: NodeId, genId: GenerationId) => void;

  /**
   * Helper: Get the Generation ID that should be displayed for the current Active Node
   * Returns null if not recorded (UI layer can decide to show latest or first generation)
   */
  getActiveGenerationId: () => GenerationId | null;

  /** Clear all state */
  clearSelection: () => void;
}

/**
 * Zustand store for selection state
 */
export const useSelectionStore = create<SelectionState>((set, get) => ({
  activeNodeId: null,
  activeNodeType: null,
  generationSelections: {},

  setActiveNode: (nodeId, type = null) =>
    set({
      activeNodeId: nodeId,
      activeNodeType: type,
    }),

  selectGeneration: (nodeId, genId) =>
    set((state) => ({
      generationSelections: {
        ...state.generationSelections,
        [nodeId]: genId,
      },
    })),

  getActiveGenerationId: () => {
    const { activeNodeId, generationSelections } = get();
    if (!activeNodeId) return null;
    return generationSelections[activeNodeId] ?? null;
  },

  clearSelection: () =>
    set({
      activeNodeId: null,
      activeNodeType: null,
      generationSelections: {},
    }),
}));
