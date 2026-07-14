/**
 * Pure selectors: derive tab-sized slices (memory, prompt, validation, execution replay)
 * from NormalizedTrace + generation nodes. Prefer importing these over building a full legacy
 * GenerationNode when a panel only needs one concern.
 */

import { sortTraceEventsByTimestampAndSeq } from "@entities/trace/lib/traceEventOrdering.ts";
import { getGenerationsForHost } from "@entities/trace/lib/treeFinder";
import type { BudgetUpdateEvent, GenerationEndEvent, TraceEvent } from "@rejelly/core";
import type { NormalizedTrace } from "src/entities/trace/types";
import type { MemoryDiff, OutputValidation, PromptAssembly } from "../ui/types";
import type { ExecutionHistoryReplayResult } from "./executionHistoryFromUpdateEvents";
import { buildExecutionHistoryFromUpdateEvents } from "./executionHistoryFromUpdateEvents";

/** Collect raw update events mounted under a generation (detail span ids). */
export function collectUpdateEventsForGeneration(
  trace: NormalizedTrace.Trace,
  generation: NormalizedTrace.GenerationNode,
): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const id of generation.mountedDetailIds) {
    const n = trace.nodeMap[id];
    if (n?.type === "update") {
      out.push(...n.events);
    }
  }
  return sortTraceEventsByTimestampAndSeq(out);
}

/** Sum delta.totalTokens from budget:update events in mounted update nodes (per generation). */
export function sumBudgetUpdateDeltaTokens(events: TraceEvent[]): number {
  let sum = 0;
  for (const e of events) {
    if (e.type !== "budget:update") continue;
    const delta = (e as BudgetUpdateEvent).delta;
    sum += Number(delta?.totalTokens) || 0;
  }
  return sum;
}

/**
 * Memory diff vs previous generation end on the same host (agent), if end.memory differs.
 */
export function selectMemoryDiffForGeneration(
  trace: NormalizedTrace.Trace,
  hostSpanId: string,
  generation: NormalizedTrace.GenerationNode,
  end: GenerationEndEvent,
): MemoryDiff | undefined {
  const gens = getGenerationsForHost(trace, hostSpanId).filter(
    (g): g is NormalizedTrace.GenerationNode => g.type === "generation",
  );
  const idx = gens.findIndex((g) => g.spanId === generation.spanId);
  if (idx < 0 || !end.memory) return undefined;

  let prevMemory: Record<string, unknown> | undefined;
  if (idx > 0) {
    const prevEnd = gens[idx - 1]?.endEvent;
    if (prevEnd?.memory) {
      prevMemory = prevEnd.memory;
    }
  }

  try {
    const currentMemoryStr = JSON.stringify(end.memory, null, 2);
    const prevMemoryStr = prevMemory ? JSON.stringify(prevMemory, null, 2) : "{}";
    if (currentMemoryStr === prevMemoryStr) return undefined;
    return {
      prevMemory: prevMemoryStr,
      currentMemory: currentMemoryStr,
    };
  } catch {
    return undefined;
  }
}

export function selectOutputValidationFromGenerationEnd(
  end: GenerationEndEvent,
): OutputValidation | undefined {
  if (end.result === undefined && !end.error) {
    return undefined;
  }
  const raw =
    end.result === undefined
      ? ""
      : typeof end.result === "string"
        ? end.result
        : JSON.stringify(end.result, null, 2);
  if (end.error) {
    return {
      raw,
      validated: false,
      data: end.result,
      errors: [{ name: end.error.name, message: end.error.message }],
    };
  }
  return {
    raw,
    validated: true,
    data: end.result,
  };
}

export function selectPromptAssemblyFromGenerationEnd(
  end: GenerationEndEvent,
): PromptAssembly | undefined {
  if (!end.draft) return undefined;
  return {
    system: end.draft.systemPrompts?.length > 0 ? end.draft.systemPrompts.join("\n") : undefined,
    full: JSON.stringify(end.draft, null, 2),
  };
}

/**
 * Execution timeline + schema from update-node events under this generation.
 * Pass `updateEvents` when you already collected them to avoid a second scan.
 */
export function selectExecutionReplayForAgentGeneration(
  trace: NormalizedTrace.Trace,
  generation: NormalizedTrace.GenerationNode,
  updateEvents?: TraceEvent[],
): ExecutionHistoryReplayResult | undefined {
  const events = updateEvents ?? collectUpdateEventsForGeneration(trace, generation);
  return buildExecutionHistoryFromUpdateEvents(events, generation.spanId);
}
