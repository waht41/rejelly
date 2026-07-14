import type { NormalizedTrace } from "@entities/trace/types";
import type { BudgetRecord, BudgetUpdateEvent, UsageItem } from "@rejelly/core";
import { compareTraceEventsByTimestampAndSeq } from "./traceEventOrdering.ts";

export interface BudgetItemSummary {
  key: string;
  type: UsageItem["type"];
  name: string;
  provider?: string;
  unit?: string;
  quantity?: number;
  callCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  details?: Record<string, number>;
  costs: BudgetRecord;
}

export interface BudgetUsageSummary {
  costs: BudgetRecord;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  callCount: number;
  details?: Record<string, number>;
  items: BudgetItemSummary[];
}

export interface BudgetSummaryForSpan {
  spanId: string;
  own: BudgetUsageSummary;
  children: BudgetUsageSummary;
  aggregate: BudgetUsageSummary;
  ownEvents: BudgetUpdateEvent[];
  childEvents: BudgetUpdateEvent[];
}

function createEmptyBudgetUsageSummary(): BudgetUsageSummary {
  return {
    costs: {},
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    callCount: 0,
    items: [],
  };
}

function addRecord(target: BudgetRecord, source: BudgetRecord | undefined): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + (Number(value) || 0);
  }
}

function addDetails(
  target: BudgetUsageSummary | BudgetItemSummary,
  source: Record<string, number> | undefined,
): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    if (!target.details) {
      target.details = {};
    }
    target.details[key] = (target.details[key] ?? 0) + (Number(value) || 0);
  }
}

function getUsageItemKey(item: UsageItem): string {
  if (item.type === "model") {
    return ["model", item.provider ?? "", item.name].join(":");
  }
  return ["tool", item.name, item.unit].join(":");
}

function mergeUsageItem(target: BudgetItemSummary, item: UsageItem): void {
  target.callCount += 1;
  addRecord(target.costs, item.costs);

  if (item.type === "model") {
    target.promptTokens += Number(item.tokens.prompt) || 0;
    target.completionTokens += Number(item.tokens.completion) || 0;
    target.totalTokens += Number(item.tokens.total) || 0;
    addDetails(target, item.tokens.details);
  } else {
    target.quantity = (target.quantity ?? 0) + (Number(item.quantity) || 0);
  }
}

function createItemSummary(item: UsageItem): BudgetItemSummary {
  const summary: BudgetItemSummary = {
    key: getUsageItemKey(item),
    type: item.type,
    name: item.name,
    callCount: 0,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    costs: {},
  };

  if (item.type === "model") {
    summary.provider = item.provider;
  } else {
    summary.unit = item.unit;
    summary.quantity = 0;
  }

  mergeUsageItem(summary, item);
  return summary;
}

function cloneBudgetUsageSummary(summary: BudgetUsageSummary): BudgetUsageSummary {
  return {
    costs: { ...summary.costs },
    totalTokens: summary.totalTokens,
    promptTokens: summary.promptTokens,
    completionTokens: summary.completionTokens,
    callCount: summary.callCount,
    ...(summary.details ? { details: { ...summary.details } } : {}),
    items: summary.items.map((item) => ({
      ...item,
      costs: { ...item.costs },
      ...(item.details ? { details: { ...item.details } } : {}),
    })),
  };
}

export function summarizeBudgetEvents(events: readonly BudgetUpdateEvent[]): BudgetUsageSummary {
  const summary = createEmptyBudgetUsageSummary();
  const itemsByKey = new Map<string, BudgetItemSummary>();

  for (const event of events) {
    const delta = event.delta;
    summary.totalTokens += Number(delta.totalTokens) || 0;
    summary.promptTokens += Number(delta.promptTokens) || 0;
    summary.completionTokens += Number(delta.completionTokens) || 0;
    summary.callCount += Number(delta.callCount) || 0;
    addRecord(summary.costs, delta.costs);
    addDetails(summary, delta.details);

    for (const item of delta.items ?? []) {
      const key = getUsageItemKey(item);
      const existing = itemsByKey.get(key);
      if (existing) {
        mergeUsageItem(existing, item);
      } else {
        itemsByKey.set(key, createItemSummary(item));
      }
    }
  }

  summary.items = Array.from(itemsByKey.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type === "model" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return summary;
}

function isDescendantOfSpan(
  trace: NormalizedTrace.Trace,
  candidateSpanId: string,
  rootSpanId: string,
): boolean {
  let parentSpanId = trace.nodeMap[candidateSpanId]?.parentSpanId;
  const seen = new Set<string>();

  while (parentSpanId && !seen.has(parentSpanId)) {
    if (parentSpanId === rootSpanId) {
      return true;
    }
    seen.add(parentSpanId);
    parentSpanId = trace.nodeMap[parentSpanId]?.parentSpanId;
  }

  return false;
}

function findFirstHostSpanId(
  trace: NormalizedTrace.Trace,
  candidateSpanId: string,
): string | undefined {
  let parentSpanId = trace.nodeMap[candidateSpanId]?.parentSpanId;
  const seen = new Set<string>();

  while (parentSpanId && !seen.has(parentSpanId)) {
    seen.add(parentSpanId);
    const parent = trace.nodeMap[parentSpanId];
    if (!parent) {
      return parentSpanId;
    }
    if (parent.type !== "update") {
      return parent.spanId;
    }
    parentSpanId = parent.parentSpanId;
  }

  return trace.nodeMap[candidateSpanId]?.hostNodeId;
}

function getBudgetEventsFromUpdateNode(node: NormalizedTrace.UpdateNode): BudgetUpdateEvent[] {
  return node.events.filter((event): event is BudgetUpdateEvent => event.type === "budget:update");
}

function mergeUsageSummaries(
  left: BudgetUsageSummary,
  right: BudgetUsageSummary,
): BudgetUsageSummary {
  const merged = cloneBudgetUsageSummary(left);
  merged.totalTokens += right.totalTokens;
  merged.promptTokens += right.promptTokens;
  merged.completionTokens += right.completionTokens;
  merged.callCount += right.callCount;
  addRecord(merged.costs, right.costs);
  addDetails(merged, right.details);

  const itemMap = new Map<string, BudgetItemSummary>();
  for (const item of merged.items) {
    itemMap.set(item.key, item);
  }

  for (const item of right.items) {
    const existing = itemMap.get(item.key);
    if (existing) {
      existing.callCount += item.callCount;
      existing.totalTokens += item.totalTokens;
      existing.promptTokens += item.promptTokens;
      existing.completionTokens += item.completionTokens;
      existing.quantity = (existing.quantity ?? 0) + (item.quantity ?? 0);
      addRecord(existing.costs, item.costs);
      addDetails(existing, item.details);
    } else {
      const cloned = {
        ...item,
        costs: { ...item.costs },
        ...(item.details ? { details: { ...item.details } } : {}),
      };
      itemMap.set(cloned.key, cloned);
    }
  }

  merged.items = Array.from(itemMap.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type === "model" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return merged;
}

export function selectBudgetSummaryForSpan(
  trace: NormalizedTrace.Trace,
  spanId: string,
): BudgetSummaryForSpan {
  const ownEvents: BudgetUpdateEvent[] = [];
  const childEvents: BudgetUpdateEvent[] = [];

  for (const node of Object.values(trace.nodeMap)) {
    if (node.type !== "update") continue;

    const budgetEvents = getBudgetEventsFromUpdateNode(node);
    if (budgetEvents.length === 0) continue;

    if (findFirstHostSpanId(trace, node.spanId) === spanId) {
      ownEvents.push(...budgetEvents);
      continue;
    }

    if (isDescendantOfSpan(trace, node.spanId, spanId)) {
      childEvents.push(...budgetEvents);
    }
  }

  ownEvents.sort(compareTraceEventsByTimestampAndSeq);
  childEvents.sort(compareTraceEventsByTimestampAndSeq);

  const own = summarizeBudgetEvents(ownEvents);
  const children = summarizeBudgetEvents(childEvents);
  const aggregate = mergeUsageSummaries(own, children);

  return {
    spanId,
    own,
    children,
    aggregate,
    ownEvents,
    childEvents,
  };
}
