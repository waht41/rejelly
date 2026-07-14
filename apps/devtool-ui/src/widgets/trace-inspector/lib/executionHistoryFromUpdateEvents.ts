/** Replays prompt/turn/model events into ExecutionHistory from normalized UpdateNode logs. */

import { EVENTS } from "@entities/trace/core/traceEventConstants";
import { convertMessagesToChatMessages } from "@entities/trace/lib/convertMessagesToChatMessages";
import type {
  Message,
  ModelCallEndEvent,
  PromptAgentEndEvent,
  PromptAgentStartEvent,
  TraceEvent,
  TurnEndEvent,
  TurnStartEvent,
  ValidationFailEvent,
} from "@rejelly/core";
import type { ChatMessage, ErrorInfo } from "src/entities/trace/types";
import type { ExecutionHistory, Turn } from "../ui/types";

export interface ExecutionHistoryReplayResult {
  executionHistory: ExecutionHistory;
  /** From promptAgent:start */
  schema?: unknown;
}

interface TurnRuntimeEntry {
  spanId: string;
  step: number;
  turn: Turn;
}

function buildAssistantMessageFromTurnEnd(event: TurnEndEvent): ChatMessage | undefined {
  if (!event.message) {
    return undefined;
  }

  const converted = convertMessagesToChatMessages([event.message]);
  const assistantMessage = converted[0];

  if (
    !assistantMessage ||
    (assistantMessage.content.length === 0 &&
      (!assistantMessage.toolCalls || assistantMessage.toolCalls.length === 0) &&
      !assistantMessage.reasoning_content)
  ) {
    return undefined;
  }

  return assistantMessage.role === "assistant"
    ? assistantMessage
    : {
        ...assistantMessage,
        role: "assistant",
      };
}

function omitTypeTimestamp<T extends { type: string; timestamp: number }>(
  e: T,
): Omit<T, "type" | "timestamp"> {
  const { type: _t, timestamp: _ts, ...rest } = e;
  return rest;
}

function buildTurnStartMessages(
  rawMessages: Message[],
  previousTurnMessages: ChatMessage[] | undefined,
): ChatMessage[] {
  const normalizedMessages = convertMessagesToChatMessages(rawMessages);
  if (!previousTurnMessages || previousTurnMessages.length === 0) {
    const firstTurnMessages = [...normalizedMessages];
    while (firstTurnMessages[firstTurnMessages.length - 1]?.role === "assistant") {
      firstTurnMessages.pop();
    }
    return firstTurnMessages;
  }

  const previousCount = previousTurnMessages.length;
  const stableHistory = normalizedMessages.slice(0, previousCount);
  const currentTurnInputs = normalizedMessages
    .slice(previousCount)
    .filter((message) => message.role !== "assistant");

  return [...stableHistory, ...currentTurnInputs];
}

/**
 * Replays sorted update-span events (same order as emitted) into ExecutionHistory + optional schema.
 */
export function buildExecutionHistoryFromUpdateEvents(
  events: TraceEvent[],
  generationSpanId: string,
): ExecutionHistoryReplayResult | undefined {
  if (events.length === 0) {
    return undefined;
  }

  const history: ExecutionHistory = {
    id: generationSpanId,
    status: "running",
    turns: [],
  };

  let schema: unknown;
  const turnBySpanId = new Map<string, TurnRuntimeEntry>();
  const turnEntriesByStep = new Map<number, TurnRuntimeEntry[]>();

  for (const event of events) {
    switch (event.type) {
      case EVENTS.PROMPT_AGENT_START: {
        const e = event as PromptAgentStartEvent;
        history.status = "running";
        if (e.schema !== undefined) {
          schema = e.schema;
        }
        break;
      }

      case EVENTS.PROMPT_AGENT_END: {
        const e = event as PromptAgentEndEvent;
        history.status = e.success ? "success" : "failed";

        const isCached = e.cache === true;
        const rest = omitTypeTimestamp(e);

        if (isCached && history.turns.length === 0 && e.result !== undefined) {
          const turn: Turn = {
            id: 1,
            status: "success",
            inputPayload: rest,
            messages: [],
            validationErrors: [],
            finalResult: {
              output: typeof e.result === "string" ? e.result : JSON.stringify(e.result),
              isCached: true,
            },
          };
          history.turns.push(turn);
        } else if (history.turns.length > 0 && e.result !== undefined) {
          const lastTurn = history.turns[history.turns.length - 1];
          if (!lastTurn.finalResult) {
            lastTurn.finalResult = {
              output: typeof e.result === "string" ? e.result : JSON.stringify(e.result),
              isCached: isCached || false,
            };
          }
        }
        break;
      }

      case EVENTS.TURN_START: {
        const e = event as TurnStartEvent;
        const step = e.step;
        const spanId = e.trace?.spanId;
        const previousTurn = history.turns[history.turns.length - 1];
        const turn: Turn = {
          id: step,
          status: "running",
          inputPayload: omitTypeTimestamp(e),
          messages: buildTurnStartMessages(e.messages, previousTurn?.messages),
          validationErrors: [],
        };
        history.turns.push(turn);

        if (!spanId) break;

        const entry: TurnRuntimeEntry = { spanId, step, turn };
        turnBySpanId.set(spanId, entry);
        const stepEntries = turnEntriesByStep.get(step) ?? [];
        stepEntries.push(entry);
        turnEntriesByStep.set(step, stepEntries);
        break;
      }

      case EVENTS.TURN_END: {
        const e = event as TurnEndEvent;
        const step = e.step;
        const spanId = e.trace?.spanId;
        let turnEntry = spanId ? turnBySpanId.get(spanId) : undefined;

        if (!turnEntry) {
          const stepEntries = turnEntriesByStep.get(step) ?? [];
          if (stepEntries.length > 0) {
            turnEntry = stepEntries[stepEntries.length - 1];
          }
        }

        const turn = turnEntry?.turn;
        if (turn) {
          turn.status = e.success ? "success" : "failed";

          if (e.error) {
            turn.error = e.error as ErrorInfo;
          }

          const assistantMessage = buildAssistantMessageFromTurnEnd(e);
          if (assistantMessage) {
            turn.messages = [...(turn.messages ?? []), assistantMessage];
          }

          if (spanId) {
            turnBySpanId.delete(spanId);
          }
        }
        break;
      }

      case EVENTS.VALIDATION_FAIL: {
        const e = event as ValidationFailEvent;
        const currentTurn = history.turns[history.turns.length - 1];
        if (currentTurn) {
          currentTurn.validationErrors = e.errors.map(
            (err) => err.message || err.name || "Validation error",
          );
        }
        break;
      }

      case EVENTS.MODEL_CALL_END: {
        const e = event as ModelCallEndEvent;
        const currentTurn = history.turns[history.turns.length - 1];
        if (currentTurn) {
          if (!currentTurn.usage && e.usage) {
            currentTurn.usage = {
              promptTokens: e.usage.promptTokens || 0,
              completionTokens: e.usage.completionTokens || 0,
            };
          }
        }
        break;
      }

      default:
        break;
    }
  }

  if (history.turns.length === 0 && schema === undefined) {
    return undefined;
  }

  return { executionHistory: history, schema };
}
