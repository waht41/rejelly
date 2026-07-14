/**
 * Deterministic ID Generation
 *
 * All types (agent, prompt, tool) use incrementing seq from callCounters so each
 * invocation gets a unique callId for tracing and DevTool. Journal cache remains
 * keyed by contentHash and is independent of callId.
 */

import type { AgentContext } from "../context/type";
import { REJELLY_ROOT } from "../shared/const";

/**
 * Generate call ID for tracing, DevTool, and replay
 *
 * Format: ${ParentCallId}/${Type}:${ConfigId}:${Seq}
 *
 * Seq is strictly increasing per (type, configId) under the parent so that multiple
 * invocations (e.g. 3x search tool) get distinct IDs (root/tool:search:0, :1, :2) and
 * do not collide in OpenTelemetry spans or DevTool tree.
 */
export function generateCallId(
  parentCtx: AgentContext | undefined,
  type: "agent" | "prompt" | "tool",
  configId: string,
): string {
  const parentCallId = parentCtx?.callId ?? REJELLY_ROOT;
  if (!parentCtx) return `${parentCallId}/${type}:${configId}:0`;

  const counterKey = `${type}:${configId}`;
  if (parentCtx.draft.callCounters[counterKey] === undefined) {
    parentCtx.draft.callCounters[counterKey] = 0;
  }
  const seq = parentCtx.draft.callCounters[counterKey]++;
  return `${parentCallId}/${type}:${configId}:${seq}`;
}
