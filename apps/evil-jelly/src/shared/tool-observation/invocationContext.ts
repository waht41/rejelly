/**
 * Per-call side channel between a tool handler and the logging middleware that
 * wrapped it, carried in `AsyncLocalStorage` so parallel tool calls each get
 * their own slot without threading an argument through every handler.
 *
 * Two things travel through it: the handle identifying this call (so a handler
 * streaming live output can say which tool the bytes belong to) and an observation
 * detail the handler produced along the way (currently a reviewed diff).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolCallHandle, ToolObservationDetail } from "./model";

type ToolCallSlot = {
  call?: ToolCallHandle;
  detail?: ToolObservationDetail;
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
