import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolTranscriptDetail } from "../../shared/types";

type ToolDetailSlot = {
  detail?: ToolTranscriptDetail;
};

const detailStorage = new AsyncLocalStorage<ToolDetailSlot>();

export async function runWithToolDetailSlot<T>(fn: () => Promise<T>): Promise<T> {
  return detailStorage.run({}, fn);
}

export function recordActiveToolDetail(detail: ToolTranscriptDetail): void {
  const slot = detailStorage.getStore();
  if (!slot) {
    return;
  }
  slot.detail = detail;
}

export function takeActiveToolDetail(): ToolTranscriptDetail | undefined {
  const slot = detailStorage.getStore();
  if (!slot) {
    return undefined;
  }
  const detail = slot.detail;
  slot.detail = undefined;
  return detail;
}
