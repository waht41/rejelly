/**
 * Timeline helpers and re-exports of generationSelectors for inspector tabs.
 *
 * Agent / Span / RunWith detail UIs consume NormalizedTrace + selectors directly.
 */

import { selectBudgetSummaryForSpan } from "@entities/trace/lib/budgetSelectors.ts";
import { getGenerationsForHost } from "@entities/trace/lib/treeFinder";
import type { GenerationEndReason } from "@rejelly/core";
import type { ExecutionStatus, NormalizedTrace } from "src/entities/trace/types";

/** Re-export collection helpers + selectors for call sites that only need a slice. */
export {
  collectUpdateEventsForGeneration,
  selectExecutionReplayForAgentGeneration,
  selectMemoryDiffForGeneration,
  selectOutputValidationFromGenerationEnd,
  selectPromptAssemblyFromGenerationEnd,
  sumBudgetUpdateDeltaTokens,
} from "./generationSelectors";

function mapEndReasonToFinishReason(endReason: GenerationEndReason | undefined): string {
  if (endReason === "return") return "return";
  if (endReason === "error") return "error";
  if (endReason === "reborn") return "reborn";
  return "unknown";
}

/**
 * Timeline strip items for an agent host (GenericTimelineHeader).
 */
export function getAgentTimelineGenerationItems(
  trace: NormalizedTrace.Trace,
  normAgent: NormalizedTrace.AgentNode,
): Array<{
  id: number;
  status: ExecutionStatus;
  startTime: number;
  endTime?: number;
  duration?: number;
  finishReason?: string;
  budgetTokens?: number;
}> {
  const gens = getGenerationsForHost(trace, normAgent.spanId).filter(
    (g): g is NormalizedTrace.GenerationNode => g.type === "generation",
  );
  return gens.map((g) => {
    const end = g.endEvent;
    return {
      id: g.startEvent.generationId,
      status: g.status,
      startTime: g.startTime,
      endTime: g.endTime,
      duration: g.duration,
      finishReason: end ? mapEndReasonToFinishReason(end.endReason) : "unknown",
      budgetTokens: selectBudgetSummaryForSpan(trace, g.spanId).own.totalTokens,
    };
  });
}
