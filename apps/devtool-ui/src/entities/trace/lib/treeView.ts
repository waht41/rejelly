/**
 * Trace Tree Utility Functions
 *
 * Pure functions for tree traversal and node operations
 */

import type { NormalizedTrace } from "src/entities/trace/types";
import {
  findGenerationNodeByHostAndId,
  findNormalizedGenerationThatSpawnedChild,
  getGenerationsForHost,
  getStructuralChildren,
  isStructuralSidebarNode,
  isStructuralUnderGenerationSpan,
} from "./treeFinder";

/**
 * Structural host for generation context (parent chain for gray / origin badges).
 */
export type HostStructural = NormalizedTrace.AgentNode;

/**
 * Precomputed row model for flat list rendering (no recursive React tree).
 */
export interface FlatTraceNode {
  node: NormalizedTrace.SideTreeNode;
  level: number;
  isExpanded: boolean;
  parentHost: HostStructural | null;
  parentGenerationId: number | null;
  // Resolved when this node is an agent with multiple generations (null if single gen).
  activeGenerationId: number | null;
  isGrayedOut: boolean;
  calledByGenerationId: number | null;
  showOriginBadge: boolean;
  hasChildren: boolean;
  generationBadge:
    | {
        kind: "multi";
        total: number;
        /** null when viewing latest (muted badge style). */
        current: number | null;
      }
    | { kind: "singleCount"; count: number }
    | null;
  /** Auto-select first generation on row click when none selected yet. */
  autoSelectGenerationIdOnClick: number | null;
}

/**
 * DFS flatten: expand controls traversal (collapsed = skip children).
 * generationSelections affects gray/badge context only.
 */
export function buildFlatTraceTree(
  trace: NormalizedTrace.Trace,
  expandedNodes: Set<string>,
  generationSelections: Record<string, number>,
): FlatTraceNode[] {
  const flatList: FlatTraceNode[] = [];

  function visit(
    nodeId: string,
    level: number,
    parentHost: HostStructural | null,
    parentGenerationId: number | null,
  ) {
    const raw = trace.nodeMap[nodeId];
    if (!raw || !isStructuralSidebarNode(raw)) {
      return;
    }
    const node = raw;

    const children = getStructuralChildren(trace, nodeId);
    const hasChildren = children.length > 0;

    const genSel = generationSelections[node.spanId];
    const hostGenerations = node.type === "agent" ? getGenerationsForHost(trace, node.spanId) : [];

    let activeGenerationId: number | null = null;
    if (node.type === "agent") {
      if (hostGenerations.length <= 1) {
        activeGenerationId = null;
      } else {
        const last = hostGenerations[hostGenerations.length - 1];
        activeGenerationId = genSel ?? last.startEvent.generationId;
      }
    }

    let isGrayedOut = false;
    if (parentHost && parentGenerationId != null) {
      const gen = findGenerationNodeByHostAndId(trace, parentHost.spanId, parentGenerationId);
      if (gen) {
        isGrayedOut = !isStructuralUnderGenerationSpan(trace, node.spanId, gen.spanId);
      }
    }

    let calledByGenerationId: number | null = null;
    if (parentHost) {
      calledByGenerationId = findNormalizedGenerationThatSpawnedChild(
        trace,
        parentHost.spanId,
        node.spanId,
      );
    }

    const parentHostGenerations = parentHost ? getGenerationsForHost(trace, parentHost.spanId) : [];
    const showOriginBadge =
      calledByGenerationId !== null && parentHost !== null && parentHostGenerations.length > 1;

    let generationBadge: FlatTraceNode["generationBadge"] = null;
    let autoSelectGenerationIdOnClick: number | null = null;

    if (node.type === "agent" && hostGenerations.length > 0 && genSel === undefined) {
      autoSelectGenerationIdOnClick = hostGenerations[0].startEvent.generationId;
    }

    if (node.type === "agent") {
      const legacyAgent = node as NormalizedTrace.AgentNode;
      const agentGenCount = legacyAgent.endEvent?.generationCount ?? hostGenerations.length;
      if (hostGenerations.length > 1) {
        const latestGenerationId =
          hostGenerations[hostGenerations.length - 1].startEvent.generationId;
        const isViewingLatest =
          activeGenerationId === null || activeGenerationId === latestGenerationId;
        generationBadge = {
          kind: "multi",
          total: hostGenerations.length,
          current: isViewingLatest ? null : activeGenerationId,
        };
      } else if (agentGenCount > 0) {
        generationBadge = { kind: "singleCount", count: agentGenCount };
      }
    }

    flatList.push({
      node,
      level,
      isExpanded: expandedNodes.has(nodeId),
      parentHost,
      parentGenerationId,
      activeGenerationId,
      isGrayedOut,
      calledByGenerationId,
      showOriginBadge,
      hasChildren,
      generationBadge,
      autoSelectGenerationIdOnClick,
    });

    if (!expandedNodes.has(nodeId)) {
      return;
    }

    const childParentHost: HostStructural | null =
      node.type === "agent" ? (node as HostStructural) : parentHost;
    const childParentGenerationId: number | null =
      node.type === "agent" && activeGenerationId !== null
        ? activeGenerationId
        : parentGenerationId;

    for (const child of children) {
      visit(child.spanId, level + 1, childParentHost, childParentGenerationId);
    }
  }

  for (const rootId of trace.structuralRootIds) {
    visit(rootId, 0, null, null);
  }

  return flatList;
}
