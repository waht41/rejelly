/**
 * Snapshot Restore
 *
 * Restores AgentSnapshot from linear TraceEvent array.
 * Implements time-travel functionality by reconstructing tree structure from flat trace.
 */

import { createEmptyBudgetState } from "../context/factory";
import type { AgentFrameSnapshot } from "../context/snapshot";
import { RestoreError } from "../domain/errors";
import type {
  AgentEndEvent,
  AgentStartEvent,
  GenerationEndEvent,
  ToolsExecuteEndEvent,
  TraceEvent,
  TurnEndEvent,
} from "../domain/events";
import { EVENTS, TRACE_EVENT_SCHEMA_VERSION } from "../domain/events";
import { REJELLY_ROOT, SNAPSHOT_VERSION } from "../shared/const";
import { logger } from "../shared/logger/instance";
import type { AgentSnapshot } from "./type";

/**
 * Restore options
 */
export interface RestoreOptions {
  /**
   * Target span ID
   * If not provided, defaults to the last event in the trace (restore to latest state)
   */
  spanId?: string;

  /**
   * Recovery time anchor
   * - 'before': Rollback to before this Span starts (for Retry / retry this step)
   *   Snapshot will not contain this Span's Frame/Journal, looks like it was never executed.
   * - 'after': Rollback to after this Span ends (for Resume / skip this step)
   *   Snapshot will contain this Span's execution result/cache, next execution will hit cache directly.
   * @default 'after'
   */
  anchor?: "before" | "after";

  /**
   * Metadata to attach to the restored snapshot. When this snapshot is passed to
   * runWith(..., { snapshot }), each entry surfaces as a `restoration.<key>` span attribute
   * on the runWith span (trace.attributes), so it is queryable verbatim in OTLP.
   * Use for runtime intent (e.g. { attempt: 2, branch: "fix-prompt" }) when time-traveling.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Restore snapshot from trace events
 *
 * Reconstructs tree-structured AgentSnapshot from linear TraceEvent array.
 * Uses stack-based state machine to rebuild nested frame hierarchy.
 *
 * @param trace - Array of trace events (linear timeline)
 * @param options - Restore options (spanId, anchor). If not provided, restores to the latest state.
 * @returns Restored agent snapshot
 */
export function restoreSnapshot(trace: TraceEvent[], options: RestoreOptions = {}): AgentSnapshot {
  const { spanId, anchor = "after", metadata: optionsMetadata } = options;

  // Validate trace is not empty
  if (trace.length === 0) {
    throw new RestoreError("Restore failed: Trace is empty.");
  }

  // Persisted traces may come from a different build; only the current wire format restores.
  const foreignEvent = trace.find((event) => event.schemaVersion !== TRACE_EVENT_SCHEMA_VERSION);
  if (foreignEvent) {
    throw new RestoreError(
      `Restore failed: trace event schema version ${JSON.stringify(foreignEvent.schemaVersion)} ` +
        `does not match this build's ${TRACE_EVENT_SCHEMA_VERSION}.`,
    );
  }

  // Sort trace events by timestamp to ensure chronological order
  const sortedTrace = [...trace].sort((a, b) => a.timestamp - b.timestamp);

  /**
   * Helper function to safely get spanId from event
   * All events have trace field, but types differ (AgentStartEvent/AgentEndEvent use Omit<TraceContext, 'generationId'>)
   */
  function getEventSpanId(event: TraceEvent): string | undefined {
    if (
      "trace" in event &&
      event.trace &&
      typeof event.trace === "object" &&
      "spanId" in event.trace
    ) {
      return event.trace.spanId as string;
    }
    return undefined;
  }

  /**
   * Helper function to get parentSpanId from event
   */
  function _getEventParentSpanId(event: TraceEvent): string | undefined {
    if (
      "trace" in event &&
      event.trace &&
      typeof event.trace === "object" &&
      "parentSpanId" in event.trace
    ) {
      return event.trace.parentSpanId as string;
    }
    return undefined;
  }

  /**
   * Generate callId for agent frame based on parent callId and agentId
   * Format: ${parentCallId}/agent:${agentId}:${seq}
   *
   * @param parentCallId - Parent frame's callId (or 'root' for root agent)
   * @param agentId - Agent configuration ID
   * @param existingChildren - Existing children in parent frame to determine seq
   * @returns Generated callId
   */
  function generateCallIdForFrame(
    parentCallId: string,
    agentId: string,
    existingChildren: Record<string, AgentFrameSnapshot>,
  ): string {
    // Check existing children to find next available seq
    let seq = 0;
    let callId = `${parentCallId}/agent:${agentId}:${seq}`;

    while (existingChildren[callId]) {
      seq++;
      callId = `${parentCallId}/agent:${agentId}:${seq}`;
    }

    return callId;
  }

  /**
   * Map from spanId to callId for lookup
   * Used to find parent's callId when processing child agents
   */
  const spanIdToCallId = new Map<string, string>();

  // ==========================================
  // 1. Locate Cutoff Point
  // ==========================================
  let cutoffIndex: number | null = null;

  // If spanId is not provided, default to the last event in trace (restore to latest state)
  if (!spanId) {
    // Restore to the end of trace (latest state)
    cutoffIndex = sortedTrace.length - 1;
  } else if (anchor === "before") {
    // Retry mode: Find this Span's START event and exclude it (slice to index before)
    // This way Snapshot has no trace of this Span, Agent will restart execution
    const foundIndex = sortedTrace.findIndex(
      (e) => getEventSpanId(e) === spanId && e.type.endsWith(":start"),
    );

    if (foundIndex === -1) {
      throw new RestoreError(
        `Restore failed: Target span "${spanId}" START event not found in trace.`,
      );
    }

    if (foundIndex === 0) {
      throw new RestoreError(
        `Restore failed: Target span "${spanId}" START event is at the beginning of trace, cannot restore before it.`,
      );
    }

    // Found and valid, exclude the START event
    cutoffIndex = foundIndex - 1;
  } else {
    // Resume mode: Find this Span's END event and include it (slice to index after)
    // This way Snapshot contains this Span's result (Journal), Agent will skip actual execution
    const foundIndex = sortedTrace.findIndex(
      (e) => getEventSpanId(e) === spanId && e.type.endsWith(":end"),
    );

    if (foundIndex === -1) {
      throw new RestoreError(
        `Restore failed: Target span "${spanId}" END event not found in trace.`,
      );
    }

    // Found, include the END event
    cutoffIndex = foundIndex;
  }

  // Get effective trace segment
  const effectiveTrace = sortedTrace.slice(0, cutoffIndex + 1);

  // ==========================================
  // 2. State Replay Machine
  // ==========================================

  // Root frame container
  let rootFrame: AgentFrameSnapshot | null = null;
  // Call stack (simulates runtime stack)
  const stack: AgentFrameSnapshot[] = [];
  for (const event of effectiveTrace) {
    // --- Case A: Agent Start (push to stack) ---
    if (event.type === EVENTS.AGENT_START) {
      const agentStartEvent = event as AgentStartEvent;
      const eventSpanId = getEventSpanId(event);
      if (!eventSpanId) {
        // Skip invalid events (should not happen in practice)
        continue;
      }

      const agentId = agentStartEvent.agentId || "unknown";
      let callId: string;

      if (stack.length === 0) {
        // First agent: callId should be root/agent:agentId:seq
        // 'root' is the parent callId (created by runWith)
        callId = generateCallIdForFrame(REJELLY_ROOT, agentId, {});
        rootFrame = {
          callId,
          agentId,
          // Memory starts empty, will be filled by Generation events
          memory: {},
          // Journal for caching Prompt and Tool
          journal: { prompt: {}, tool: {} },
          children: {},
          // Initial state defaults to running
          state: { status: "running" },
          // Budget state starts empty
          budgetState: createEmptyBudgetState(),
        };
        stack.push(rootFrame);
      } else {
        // Child agent: calculate callId based on parent
        const parent = stack[stack.length - 1];
        const parentCallId = parent.callId;
        callId = generateCallIdForFrame(parentCallId, agentId, parent.children);

        const newFrame: AgentFrameSnapshot = {
          callId,
          agentId,
          // Memory starts empty, will be filled by Generation events
          memory: {},
          // Journal for caching Prompt and Tool
          journal: { prompt: {}, tool: {} },
          children: {},
          // Initial state defaults to running
          state: { status: "running" },
          // Budget state starts empty
          budgetState: createEmptyBudgetState(),
        };

        // Mount new Frame to parent's Children
        parent.children[callId] = newFrame;
        stack.push(newFrame);
      }

      // Map spanId to callId for lookup
      spanIdToCallId.set(eventSpanId, callId);
    }

    // --- Case B: Agent End (pop from stack) ---
    else if (event.type === EVENTS.AGENT_END) {
      const agentEndEvent = event as AgentEndEvent;
      const eventSpanId = getEventSpanId(event);
      if (!eventSpanId) {
        continue;
      }

      // Find frame by spanId (using the map we created)
      const callId = spanIdToCallId.get(eventSpanId);
      if (!callId) {
        // Frame not found, skip
        continue;
      }

      // Find frame in stack (should be at top in normal execution)
      // But we search from top to bottom to find the matching frame
      let frameIndex = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].callId === callId) {
          frameIndex = i;
          break;
        }
      }

      if (frameIndex !== -1) {
        const currentFrame = stack[frameIndex];

        // 1. Mark completion status for target frame
        currentFrame.state = {
          status: agentEndEvent.success ? "completed" : "failed",
          output: agentEndEvent.result,
          error: agentEndEvent.error,
        };

        // 2. Best Effort: Handle zombie child nodes
        // If frameIndex is not at the top of stack, it means there are unclosed child agents above it
        if (frameIndex < stack.length - 1) {
          logger.warn(
            `Parent agent "${currentFrame.agentId}" ended unexpectedly. ` +
              `Force closing ${stack.length - 1 - frameIndex} active child agents.`,
          );

          // Iterate through all child frames that will be forcibly removed (from frameIndex + 1 to top)
          for (let i = frameIndex + 1; i < stack.length; i++) {
            const zombieFrame = stack[i];
            // Only fix frames that are still in 'running' state to avoid overwriting existing states
            if (zombieFrame.state.status === "running") {
              zombieFrame.state = {
                status: "failed",
                error: new Error(
                  `[Rejelly System] Parent agent "${currentFrame.agentId}" terminated before child completed.`,
                ),
              };
            }
          }
        }

        // 3. Pop this frame and all frames above it (including zombie children)
        stack.splice(frameIndex);
      }
    }

    // --- Case B2: Agent Reborn (explicitly ignore, does not change structure) ---
    else if (event.type === EVENTS.AGENT_REBORN) {
      // AgentRebornEvent does not change the frame structure
      // It only indicates a reborn occurred, which is already reflected in the state
      // Explicitly ignore to make the logic clear
      // eslint-disable-next-line no-empty
    }

    // --- Case C: Memory Recovery (Memory Rehydration) ---
    // GenerationEnd exposes final memory state for this round
    else if (event.type === EVENTS.GENERATION_END) {
      const generationEndEvent = event as GenerationEndEvent;
      const currentFrame = stack[stack.length - 1];
      if (currentFrame && generationEndEvent.memory) {
        currentFrame.memory = { ...generationEndEvent.memory };
      }
    }

    // --- Case D: Per-turn Prompt Journal (turn:end hash + output) ---
    else if (event.type === EVENTS.TURN_END) {
      const turnEndEvent = event as TurnEndEvent;
      const currentFrame = stack[stack.length - 1];
      const outputFromTurnEvent = turnEndEvent.message;
      if (
        currentFrame &&
        turnEndEvent.success &&
        turnEndEvent.contentHash &&
        outputFromTurnEvent !== undefined
      ) {
        currentFrame.journal.prompt[turnEndEvent.contentHash] = {
          output: outputFromTurnEvent,
          contentHash: turnEndEvent.contentHash,
        };
      }
    }

    // promptAgent:end is not used for journal.prompt: rows come from turn:end (Case D).

    // --- Case E: Tool Cache Recovery (Tool Journal) ---
    else if (event.type === EVENTS.TOOLS_EXECUTE_END) {
      const toolsEndEvent = event as ToolsExecuteEndEvent;
      const currentFrame = stack[stack.length - 1];
      if (currentFrame && Array.isArray(toolsEndEvent.toolResults)) {
        toolsEndEvent.toolResults.forEach((toolRes) => {
          // Key: restore successful per-tool results even when the batch had mixed failures.
          if (toolRes.success && toolRes.contentHash) {
            currentFrame.journal.tool[toolRes.contentHash] = {
              output: toolRes.output,
              contentHash: toolRes.contentHash,
            };
          }
        });
      }
    }
  }

  if (!rootFrame) {
    throw new RestoreError("Restore failed: Root agent frame not created.");
  }

  // ==========================================
  // 3. Status Fixup
  // ==========================================

  // Frames remaining in stack represent Agents that were still active at "cutoff time"
  // Regardless of whether they completed later in original Trace, at "now" this time point, they must be 'running'
  for (const frame of stack) {
    frame.state = { status: "running" };
  }

  // Get traceId and spanId from trace events
  const firstEvent = sortedTrace[0];
  const traceId = firstEvent?.trace?.traceId || `restore-${Date.now()}`;
  const restoredSpanId = spanId || getEventSpanId(effectiveTrace[effectiveTrace.length - 1]);

  const metadata =
    optionsMetadata != null && Object.keys(optionsMetadata).length > 0
      ? optionsMetadata
      : undefined;

  return {
    processId: `restore:${spanId || "latest"}:${Date.now()}`,
    timestamp: Date.now(),
    root: rootFrame,
    provenance: {
      traceId,
      spanId: restoredSpanId,
      anchor,
      source: "restore",
    },
    version: SNAPSHOT_VERSION,
    ...(metadata != null && { metadata }),
  };
}
