import type { TraceSummary } from "@entities/trace/store/types";
import type { TraceSummaryResponse } from "@shared/api-types/traces";

/** Map GET /traces/:id (or list item) response to client TraceSummary */
export function mapTraceSummaryResponse(response: TraceSummaryResponse): TraceSummary {
  return {
    traceId: response.traceId,
    timestamp: response.timestamp,
    name: response.name,
    nameSource: response.nameSource,
    agentId: undefined,
    eventCount: response.generationCount + response.llmCallCount + response.toolCallCount,
    isStarred: response.isStarred,
    tags: response.tags,
  };
}
