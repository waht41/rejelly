/**
 * GLUI Registry (The Brain)
 *
 * State-centric dispatch: AI outputs state patches, registry applies them via node sync.
 * GLUE: Declarative state over imperative actions.
 */
import { create } from "zustand";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

/** JSON-Schema-like shape for the state slice that AI can adjust (per node) */
export interface StateSchema {
  type: "object";
  description?: string;
  properties: Record<
    string,
    {
      type: string;
      description?: string;
      enum?: string[];
      items?: { type: string; enum?: string[] };
    }
  >;
  required?: string[];
}

export interface SemanticNode {
  id: string;
  parentId: string | null;
  type: string;
  data: Record<string, any>;
  description?: string;

  /** Schema of the state slice this node exposes to AI (optional = not AI-adjustable) */
  stateSchema?: StateSchema | null;

  /** Sync: apply a partial state update from AI. Only present when stateSchema is set. */
  applyStatePatch?: ((patch: Record<string, any>) => void) | null;
}

/** Snapshot node: serializable tree for AI (no functions) */
export interface SnapshotNode {
  id: string;
  parentId: string | null;
  type: string;
  data: Record<string, any>;
  description?: string;
  stateSchema?: StateSchema | null;
  children: SnapshotNode[];
}

interface GLUIStore {
  nodes: Record<string, SemanticNode>;

  // === Registration ===
  register: (node: SemanticNode) => void;
  unregister: (id: string) => void;

  // === AI state sync (GLUE: apply declarative state patches from AI) ===
  /** For each nodeId in patches, call that node's applyStatePatch with the partial state */
  applyStatePatches: (patches: Record<string, Record<string, any>>) => void;

  // === AI View ===
  getSnapshot: () => SnapshotNode[];
}

// ------------------------------------------------------------------
// Store Implementation
// ------------------------------------------------------------------

export const useGLUIStore = create<GLUIStore>((set, get) => ({
  nodes: {},

  register: (node) =>
    set((state) => ({
      nodes: { ...state.nodes, [node.id]: node },
    })),

  unregister: (id) =>
    set((state) => {
      const { [id]: _, ...rest } = state.nodes;
      return { nodes: rest };
    }),

  applyStatePatches: (patches) => {
    const { nodes } = get();
    for (const [nodeId, patch] of Object.entries(patches)) {
      const node = nodes[nodeId];
      if (!node?.applyStatePatch) {
        if (node) {
          console.warn(`[GLUI] Node ${nodeId} has no applyStatePatch (not AI-adjustable).`);
        } else {
          console.warn(`[GLUI] Node ${nodeId} not found for state patch.`);
        }
        continue;
      }
      try {
        node.applyStatePatch(patch);
      } catch (err) {
        console.error(`[GLUI] applyStatePatch failed for ${nodeId}:`, err);
      }
    }
  },

  getSnapshot: () => {
    const { nodes } = get();
    return buildTree(nodes);
  },
}));

// Helper function: Simple tree building
function buildTree(nodes: Record<string, SemanticNode>): SnapshotNode[] {
  const tree: SnapshotNode[] = [];
  const lookup: Record<string, SnapshotNode> = {};

  Object.values(nodes).forEach((n) => {
    // Strip applyStatePatch (non-serializable) for snapshot sent to AI
    const { applyStatePatch: _, ...safeNode } = n;
    lookup[n.id] = { ...safeNode, children: [] };
  });

  Object.values(nodes).forEach((n) => {
    if (n.parentId && lookup[n.parentId]) {
      lookup[n.parentId].children.push(lookup[n.id]);
    } else {
      tree.push(lookup[n.id]); // Root node (or orphaned node)
    }
  });

  return tree;
}
