/**
 * Trace Linker
 *
 * Incremental parent-child wiring for NormalizedTrace (flat nodeMap + mounted ids).
 * Only connects topology; payloads stay on raw events. Callers should set node.parentSpanId
 * from telemetry; this linker can enforce it when parentId is passed to registerNode.
 */

import type { NormalizedTrace } from "../../types";
import type { TraceWriteApi } from "./handlers/types";

/**
 * Orphan nodes waiting for their parent to appear in nodeMap
 */
interface Orphan {
  node: NormalizedTrace.TraceNode;
  parentId: string;
  onLinkParent?: Array<(parentId: string, childId: string) => void>;
}

export class TraceLinker {
  private orphans: Map<string, Orphan[]> = new Map();

  constructor(
    private trace: NormalizedTrace.Trace,
    private readonly writes: TraceWriteApi,
  ) {}

  public setTrace(trace: NormalizedTrace.Trace): void {
    this.trace = trace;
  }

  /**
   * Register a node and establish parent-child links on mountedStructuralIds / mountedDetailIds.
   *
   * 1. Stores node in nodeMap
   * 2. Sets parentSpanId when parentId is provided
   * 3. Structural roots (no parentId) are appended to structuralRootIds
   * 4. Links child to parent or queues as orphan
   * 5. Resolves pending orphans when parent arrives
   */
  public registerNode(
    node: NormalizedTrace.TraceNode,
    parentId?: string,
    onLinkParent?: (parentId: string, childId: string) => void,
  ): void {
    const callbacks = onLinkParent ? [onLinkParent] : undefined;

    this.writes.addNode(node);

    if (parentId) {
      this.writes.updateNode(node.spanId, (draft) => {
        draft.parentSpanId = parentId;
      });
    }

    if (!parentId) {
      if (node.category === "structural" && !this.trace.structuralRootIds.includes(node.spanId)) {
        this.writes.addStructuralRoot(node.spanId);
      }
      return;
    }

    const parent = this.trace.nodeMap[parentId];
    if (parent) {
      this.linkNodes(parent, node, callbacks);
    } else {
      this.addOrphan(node, parentId, callbacks);
      return;
    }

    this.checkOrphans(node.spanId);
  }

  /**
   * Append child id to the correct mount list on parent (structural vs detail).
   */
  private linkNodes(
    parent: NormalizedTrace.TraceNode,
    child: NormalizedTrace.TraceNode,
    onLinkParent?: Array<(parentId: string, childId: string) => void>,
  ): void {
    if (child.category === "detail") {
      if (!parent.mountedDetailIds.includes(child.spanId)) {
        this.writes.appendMountedDetailId(parent.spanId, child.spanId);
      }
    } else if (parent.category === "structural") {
      if (!parent.mountedStructuralIds.includes(child.spanId)) {
        this.writes.appendMountedStructuralId(parent.spanId, child.spanId);
      }
    }

    if (onLinkParent && onLinkParent.length > 0) {
      onLinkParent.forEach((callback) => {
        callback(parent.spanId, child.spanId);
      });
    }
  }

  private addOrphan(
    node: NormalizedTrace.TraceNode,
    parentId: string,
    onLinkParent?: Array<(parentId: string, childId: string) => void>,
  ): void {
    const list = this.orphans.get(parentId) || [];
    list.push({ node, parentId, onLinkParent });
    this.orphans.set(parentId, list);
  }

  public registerOrphanCallback(
    childSpanId: string,
    parentId: string,
    callback: (parentId: string, childId: string) => void,
  ): void {
    const list = this.orphans.get(parentId);
    if (!list) return;

    const orphan = list.find((o) => o.node.spanId === childSpanId);
    if (!orphan) return;

    if (!orphan.onLinkParent) {
      orphan.onLinkParent = [];
    }
    if (!orphan.onLinkParent.includes(callback)) {
      orphan.onLinkParent.push(callback);
    }
  }

  public checkOrphans(parentId: string): void {
    const list = this.orphans.get(parentId);
    if (list) {
      const parent = this.trace.nodeMap[parentId];
      if (parent) {
        list.forEach(({ node, onLinkParent }) => {
          this.linkNodes(parent, node, onLinkParent);
        });
        this.orphans.delete(parentId);
      }
    }
  }

  public linkAllOrphans(): void {
    for (const [parentId, orphans] of this.orphans.entries()) {
      const parent = this.trace.nodeMap[parentId];
      if (parent) {
        for (const orphan of orphans) {
          this.linkNodes(parent, orphan.node, orphan.onLinkParent);
        }
        this.orphans.delete(parentId);
      }
    }
  }
}
