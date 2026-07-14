/**
 * Selectors for NormalizedTrace (O(1) structural children via mountedStructuralIds;
 * detail lists via mountedDetailIds on host).
 */
import type { NormalizedTrace } from "src/entities/trace/types";

export function isStructuralSidebarNode(
  n: NormalizedTrace.TraceNode | undefined,
): n is NormalizedTrace.SideTreeNode {
  return (
    !!n &&
    n.category === "structural" &&
    (n.type === "agent" || n.type === "span" || n.type === "runWith")
  );
}

/**
 * Direct structural children (ingest-maintained mountedStructuralIds on parent).
 */
export function getStructuralChildren(
  trace: NormalizedTrace.Trace,
  parentSpanId: string,
): NormalizedTrace.SideTreeNode[] {
  const parent = trace.nodeMap[parentSpanId];
  if (!parent || parent.category !== "structural") return [];
  return parent.mountedStructuralIds
    .map((id) => trace.nodeMap[id])
    .filter((n): n is NormalizedTrace.SideTreeNode => isStructuralSidebarNode(n));
}

/** Generation nodes listed under a structural host’s mountedDetailIds. */
export function getGenerationsForHost(
  trace: NormalizedTrace.Trace,
  hostSpanId: string,
): NormalizedTrace.GenerationNode[] {
  const host = trace.nodeMap[hostSpanId];
  if (!host || host.category !== "structural") return [];
  const out: NormalizedTrace.GenerationNode[] = [];
  for (const id of host.mountedDetailIds) {
    const n = trace.nodeMap[id];
    if (n?.type === "generation") {
      out.push(n);
    }
  }
  return out.sort((a, b) => a.startTime - b.startTime);
}

/**
 * Walk up parentSpanId from nodeSpanId; true if generationSpanId appears on the path (exclusive of node itself).
 * Used to decide whether a structural child belongs to the selected generation’s subtree.
 */
export function isStructuralUnderGenerationSpan(
  trace: NormalizedTrace.Trace,
  nodeSpanId: string,
  generationSpanId: string,
): boolean {
  let pid: string | undefined = trace.nodeMap[nodeSpanId]?.parentSpanId;
  const seen = new Set<string>();
  while (pid && !seen.has(pid)) {
    seen.add(pid);
    if (pid === generationSpanId) return true;
    pid = trace.nodeMap[pid]?.parentSpanId;
  }
  return false;
}

/** Which host generation (numeric id) first “owns” this child in the parent host’s generation list. */
export function findNormalizedGenerationThatSpawnedChild(
  trace: NormalizedTrace.Trace,
  hostSpanId: string,
  childSpanId: string,
): number | null {
  const gens = getGenerationsForHost(trace, hostSpanId);
  for (const g of gens) {
    if (isStructuralUnderGenerationSpan(trace, childSpanId, g.spanId)) {
      return g.startEvent.generationId;
    }
  }
  return null;
}

/** Resolve generation span for a host + numeric generation id (for expand / gray / badge). */
export function findGenerationNodeByHostAndId(
  trace: NormalizedTrace.Trace,
  hostSpanId: string,
  generationId: number,
): NormalizedTrace.GenerationNode | undefined {
  return getGenerationsForHost(trace, hostSpanId).find(
    (g) => g.startEvent.generationId === generationId,
  );
}

/**
 * Root → leaf chain for breadcrumb: walk parentSpanId from activeNodeId, omit update nodes.
 * (Update nodes are skipped by name but still advance the parent link.)
 */
export function normalizedPathNodesRootToLeaf(
  trace: NormalizedTrace.Trace,
  activeNodeId: string,
): NormalizedTrace.TraceNode[] {
  const leafToRoot: NormalizedTrace.TraceNode[] = [];
  let id: string | undefined = activeNodeId;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const node = trace.nodeMap[id];
    if (!node) break;
    if (node.type !== "update") {
      leafToRoot.push(node);
    }
    id = node.parentSpanId;
  }
  leafToRoot.reverse();
  return leafToRoot;
}

/** Agent children spawned under this generation (legacy childrenIds → mountedStructuralIds on gen). */
export function getChildAgentsForNormalizedGeneration(
  trace: NormalizedTrace.Trace,
  gen: NormalizedTrace.GenerationNode,
): NormalizedTrace.AgentNode[] {
  return gen.mountedStructuralIds
    .map((sid) => trace.nodeMap[sid])
    .filter((n): n is NormalizedTrace.AgentNode => n?.type === "agent");
}
