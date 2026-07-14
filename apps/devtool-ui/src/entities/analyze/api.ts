/**
 * API client - centralized fetch handling for all API calls
 */

import type { AnalyzeContext, AnalyzeStreamUpdate, ChatMessage } from "@rejelly/devtool-contracts";
import { fetchSSEResponse } from "@shared/network/sse";

export type {
  AnalyzeContext,
  AnalyzeResponse,
  ChatMessage,
  CompleteResponse,
  ErrorUpdate,
  ReasoningDeltaUpdate,
  TextDeltaUpdate,
  ToolCallUpdate,
} from "@rejelly/devtool-contracts";

/**
 * Stream AI trace analysis response with incremental text updates.
 * @param question - User's question
 * @param context - Current UI context (traceId, active node, etc.)
 * @param signal - Optional AbortSignal for request cancellation
 * @returns AsyncGenerator yielding field updates and complete response
 */
export async function* streamAIAnalyze(
  question: string,
  context?: AnalyzeContext | null,
  history?: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<AnalyzeStreamUpdate> {
  const stream = fetchSSEResponse<AnalyzeStreamUpdate>("/api/v1/ai/analyze", {
    body: { question, context, history },
    signal,
  });

  // Yield all updates
  for await (const data of stream) {
    yield data;
  }
}
