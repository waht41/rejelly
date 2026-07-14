/**
 * Snapshot Dump
 *
 * Functions for exporting snapshot structure.
 */

import { safeClone } from "../../utils/object";
import { getCurrentContext } from "../context/accessor";
import type { AgentFrameSnapshot } from "../context/snapshot";
import type { AgentContext } from "../context/type";
import { SnapshotDisabledError } from "../domain/errors";
import { SNAPSHOT_VERSION } from "../shared/const";
import type { AgentSnapshot } from "./type";

/**
 * Build frame snapshot from context.
 * Uses shallow copy of children so that later mounting of child frames does not mutate runtime context.
 */
function buildFrame(ctx: AgentContext): AgentFrameSnapshot {
  const memory: Record<string, unknown> = {};
  for (const [key, value] of ctx.memory.entries()) {
    memory[key] = value;
  }

  return {
    callId: ctx.callId,
    agentId: ctx.agentId,
    memory,
    journal: {
      prompt: ctx.draft.journal.prompt,
      tool: ctx.draft.journal.tool,
    },
    children: { ...ctx.draft.children },
    state: {
      status: "running",
    },
    budgetState: ctx.budgetState,
  };
}

/**
 * Options for dumpSnapshot
 */
export interface DumpSnapshotOptions {
  /**
   * User-defined or environment-defined tags attached to the snapshot.
   * Useful for DevTool time-travel (e.g. { reason: "fix prompt typo", attempt: 2 })
   * and test fixtures (e.g. { testCase: "empty_input" }).
   */
  metadata?: Record<string, unknown>;
}

/**
 * Dump snapshot from current context.
 *
 * Builds frame tree bottom-up: start from current context, then walk up via parentContext,
 * at each step mount the current subtree into the parent frame. The latest active frame
 * overwrites any stale entry in parent's children. No contextChain array or top-down merge.
 *
 * @param options - Optional metadata to attach to the snapshot
 * @returns Complete snapshot structure with root frame
 */
export function dumpSnapshot(options?: DumpSnapshotOptions): AgentSnapshot {
  // todo flatten record
  const currentCtx = getCurrentContext();
  if (!currentCtx.enableSnapshot) {
    throw new SnapshotDisabledError(
      "dumpSnapshot is not allowed when enableSnapshot is false. Enable snapshot in createAgentContext options or set NODE_ENV=development.",
      "dump",
    );
  }
  const processId = currentCtx.trace?.traceId || `process-${Date.now()}`;
  const timestamp = Date.now();

  let currentFrame = buildFrame(currentCtx);
  let parentCtx = currentCtx.parentContext;

  while (parentCtx) {
    const parentFrame = buildFrame(parentCtx);
    parentFrame.children[currentFrame.callId] = currentFrame;
    currentFrame = parentFrame;
    parentCtx = parentCtx.parentContext;
  }

  const rootFrame = currentFrame;

  return {
    processId,
    timestamp,
    root: safeClone(rootFrame),
    provenance: {
      traceId: currentCtx.trace?.traceId || processId,
      spanId: currentCtx.trace?.spanId,
      source: "dump",
    },
    version: SNAPSHOT_VERSION,
    ...(options?.metadata != null && { metadata: options.metadata }),
  };
}
