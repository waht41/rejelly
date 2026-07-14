import type { NormalizedTrace } from "src/entities/trace/types";

export interface WaterfallRow {
  span: NormalizedTrace.AggregatedSpan;
  depth: number;
}

/** Same topology as {@link NormalizedTrace.Trace#waterfall} (aggregated spans + root ids). */
export type WaterfallSpanIndex = Pick<
  NormalizedTrace.Waterfall,
  "aggregatedSpans" | "aggregatedRootSpanIds"
>;

/**
 * Flatten aggregated span index into rows (depth-first) and compute time range [t0, t1].
 * When collapsedIds is provided, children of collapsed nodes are skipped (not traversed).
 */
export function flattenSpanTree(
  spanTree: WaterfallSpanIndex,
  collapsedIds?: Set<string>,
): {
  rows: WaterfallRow[];
  t0: number;
  t1: number;
} {
  const map = spanTree.aggregatedSpans;
  const rows: WaterfallRow[] = [];
  let t0 = Infinity;
  let t1 = -Infinity;

  function visit(spanId: string, depth: number) {
    const span = map.get(spanId);
    if (!span) return;

    rows.push({ span, depth });

    const start = span.timestamp;
    const end = span.duration != null ? start + span.duration : start;
    if (start < t0) t0 = start;
    if (end > t1) t1 = end;

    const isCollapsed = collapsedIds?.has(spanId);
    if (!isCollapsed) {
      for (const childId of span.childrenIds) {
        visit(childId, depth + 1);
      }
    }
  }

  for (const rootId of spanTree.aggregatedRootSpanIds) {
    visit(rootId, 0);
  }

  if (rows.length === 0 || t0 === Infinity) {
    t0 = 0;
    t1 = 1;
  } else if (t1 <= t0) {
    t1 = t0 + 1;
  }

  return { rows, t0, t1 };
}
