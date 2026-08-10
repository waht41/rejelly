/**
 * Per-call side channel between a tool handler and the logging middleware that
 * wrapped it, carried in `AsyncLocalStorage` so parallel tool calls each get
 * their own slot without threading an argument through every handler.
 *
 * Two things travel through it: the handle identifying this call (so a handler
 * streaming live output can say which tool the bytes belong to) and a transcript
 * detail the handler produced along the way (currently a reviewed diff).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolCallHandle, ToolTranscriptDetail } from "../types";

type ToolCallSlot = {
  call?: ToolCallHandle;
  detail?: ToolTranscriptDetail;
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

export function recordActiveToolDetail(detail: ToolTranscriptDetail): void {
  const slot = callStorage.getStore();
  if (!slot) {
    return;
  }
  slot.detail = detail;
}

export function takeActiveToolDetail(): ToolTranscriptDetail | undefined {
  const slot = callStorage.getStore();
  if (!slot) {
    return undefined;
  }
  const detail = slot.detail;
  slot.detail = undefined;
  return detail;
}
