/**
 * Per-call side channel between a tool handler and the logging middleware that
 * wrapped it, carried in `AsyncLocalStorage` so parallel tool calls each get
 * their own slot without threading an argument through every handler.
 *
 * Four things travel through it: the handle identifying this call (so a handler
 * streaming live output can say which tool the bytes belong to), an observation
 * detail produced along the way (currently a reviewed diff), structured metrics,
 * and an optional owner-reported business outcome distinct from transport completion.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ToolCallHandle,
  ToolExecutionOutcomeRecord,
  ToolObservationDetail,
  ToolObservationMetrics,
} from "./model";

type ToolCallSlot = {
  call?: ToolCallHandle;
  detail?: ToolObservationDetail;
  metrics?: ToolObservationMetrics;
  outcome?: ToolExecutionOutcomeRecord;
};

const callStorage = new AsyncLocalStorage<ToolCallSlot>();

export async function runWithToolDetailSlot<T>(fn: () => Promise<T>): Promise<T> {
  return callStorage.run({}, fn);
}

export function setActiveToolCall(call: ToolCallHandle): void {
  const slot = callStorage.getStore();
  if (!slot) {
    return;
  }
  slot.call = call;
}

/** The tool call running on this async branch, if the host issued a handle for it. */
export function getActiveToolCall(): ToolCallHandle | undefined {
  return callStorage.getStore()?.call;
}

export function recordActiveToolDetail(detail: ToolObservationDetail): void {
  const slot = callStorage.getStore();
  if (!slot) {
    return;
  }
  slot.detail = detail;
}

export function recordAppliedToolDiff(detail: {
  text: string;
  caption?: string;
  captionTitle?: string;
}): void {
  const slot = callStorage.getStore();
  if (!slot || detail.text.trim().length === 0) {
    return;
  }
  const existing = slot.detail?.type === "diff" ? slot.detail : undefined;
  slot.detail = {
    type: "diff",
    text: detail.text,
    caption: detail.caption ?? existing?.caption,
    captionTitle: detail.captionTitle ?? existing?.captionTitle,
    phase: "applied",
    presentation: existing?.presentation ?? "inline",
  };
}

export function takeActiveToolDetail(): ToolObservationDetail | undefined {
  const slot = callStorage.getStore();
  if (!slot) {
    return undefined;
  }
  const detail = slot.detail;
  slot.detail = undefined;
  return detail;
}

export function recordActiveToolMetrics(metrics: ToolObservationMetrics): void {
  const slot = callStorage.getStore();
  if (!slot) return;
  slot.metrics = metrics;
}

export function takeActiveToolMetrics(): ToolObservationMetrics | undefined {
  const slot = callStorage.getStore();
  if (!slot) return undefined;
  const metrics = slot.metrics;
  slot.metrics = undefined;
  return metrics;
}

export function recordActiveToolOutcome(outcome: ToolExecutionOutcomeRecord): void {
  const slot = callStorage.getStore();
  if (!slot) return;
  slot.outcome = outcome;
}

export function takeActiveToolOutcome(): ToolExecutionOutcomeRecord | undefined {
  const slot = callStorage.getStore();
  if (!slot) return undefined;
  const outcome = slot.outcome;
  slot.outcome = undefined;
  return outcome;
}
