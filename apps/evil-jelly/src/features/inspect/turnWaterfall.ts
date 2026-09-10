import type { Message } from "@rejelly/core";
import {
  isKnownSessionEvent,
  type SessionEvent,
  type SessionMetaLine,
} from "../../domains/session/model/sessionEvents";
import { estimateMessagesTokens } from "../../shared/model/budget/tokenEstimate";
import { projectFrozenUserInputMessage } from "../../shared/model/prompt/frozenUserInput";

export type TurnWaterfallSegmentKind =
  | "context_checkpoint"
  | "reconciliation"
  | "user"
  | "reasoning"
  | "assistant"
  | "tool_request"
  | "tool_result"
  | "compaction"
  | "runtime";

export interface TurnWaterfallSegment {
  seq: number;
  kind: TurnWaterfallSegmentKind;
  label: string;
  tokens: number;
  tokenSource: "provider" | "estimated";
  contextTokens: number;
  contextSource: "provider" | "estimated";
}

export interface TurnWaterfallInspection {
  type: "turn_waterfall_v1";
  sessionId: string;
  turnId: string;
  status: "in_progress" | "completed" | "interrupted" | "error";
  peakContextTokens: number;
  peakContextSource: "provider" | "estimated";
  segments: TurnWaterfallSegment[];
  warnings: string[];
}

function messageTokens(message: Message): number {
  return estimateMessagesTokens([message]);
}

function compactToolNames(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
    .join(", ");
}

export function projectTurnWaterfall(
  meta: SessionMetaLine,
  events: readonly SessionEvent[],
  turnId: string,
): TurnWaterfallInspection {
  const known = events.filter(isKnownSessionEvent);
  const turnEvents = known.filter(
    (event) =>
      ("turnId" in event && event.turnId === turnId) ||
      (event.type === "context_compacted" && event.activeTurnId === turnId),
  );
  if (turnEvents.length === 0)
    throw new Error(`Turn not found in Session ${meta.sessionId}: ${turnId}`);

  const modelMessages: Message[] = turnEvents.flatMap((event) =>
    event.type === "message_recorded" && event.source.kind === "model" ? [event.message] : [],
  );
  const toolNames = new Map<string, string>();
  for (const event of turnEvents) {
    if (event.type === "tool_call_completed") toolNames.set(event.toolCallId, event.toolName);
    if (event.type === "message_recorded") {
      for (const call of event.message.tool_calls ?? []) toolNames.set(call.id, call.name);
    }
  }

  const segments: TurnWaterfallSegment[] = [];
  const warnings: string[] = [];
  let contextTokens = 0;
  let contextSource: TurnWaterfallSegment["contextSource"] = "estimated";
  let peakContextTokens = 0;
  let peakContextSource: TurnWaterfallSegment["contextSource"] = "provider";
  let modelIndex = 0;
  let status: TurnWaterfallInspection["status"] = "in_progress";

  const append = (
    seq: number,
    kind: TurnWaterfallSegmentKind,
    label: string,
    tokens: number,
    tokenSource: TurnWaterfallSegment["tokenSource"],
  ) => {
    contextTokens = Math.max(0, contextTokens + tokens);
    if (tokenSource === "estimated") contextSource = "estimated";
    if (contextTokens > peakContextTokens) {
      peakContextTokens = contextTokens;
      peakContextSource = contextSource;
    } else if (contextTokens === peakContextTokens && contextSource === "estimated") {
      peakContextSource = "estimated";
    }
    segments.push({ seq, kind, label, tokens, tokenSource, contextTokens, contextSource });
  };

  for (const event of turnEvents) {
    switch (event.type) {
      case "user_input_recorded":
        append(
          event.seq,
          "user",
          event.inputKind === "steer" ? "user steer" : "user input",
          messageTokens(projectFrozenUserInputMessage(event.input)),
          "estimated",
        );
        break;
      case "model_call_completed": {
        const promptTokens = event.usage?.promptTokens;
        if (promptTokens !== undefined) {
          const delta = promptTokens - contextTokens;
          contextTokens = promptTokens;
          contextSource = "provider";
          if (contextTokens > peakContextTokens) {
            peakContextTokens = contextTokens;
            peakContextSource = "provider";
          }
          segments.push({
            seq: event.seq,
            kind: modelIndex === 0 ? "context_checkpoint" : "reconciliation",
            label:
              modelIndex === 0
                ? "prior context + system/tools"
                : `provider input #${modelIndex + 1} reconciliation`,
            tokens: delta,
            tokenSource: "provider",
            contextTokens,
            contextSource,
          });
        }
        const usage = event.usage;
        const modelMessage = modelMessages[modelIndex];
        const reasoningTokens = usage?.reasoningTokens ?? 0;
        if (reasoningTokens > 0)
          append(event.seq, "reasoning", "reasoning", reasoningTokens, "provider");
        const visibleTokens = Math.max(0, (usage?.completionTokens ?? 0) - reasoningTokens);
        if (visibleTokens > 0) {
          const names = modelMessage?.tool_calls?.map((call) => call.name) ?? [];
          append(
            event.seq,
            names.length > 0 ? "tool_request" : "assistant",
            names.length > 1
              ? `parallel tool requests (${compactToolNames(names)})`
              : names.length === 1
                ? `${names[0]} request`
                : "assistant answer",
            visibleTokens,
            "provider",
          );
        }
        modelIndex += 1;
        break;
      }
      case "message_recorded":
        if (event.source.kind === "model") break;
        if (event.message.role === "tool") {
          append(
            event.seq,
            "tool_result",
            `${toolNames.get(event.message.tool_call_id ?? "") ?? event.message.name ?? "tool"} result`,
            messageTokens(event.message),
            "estimated",
          );
        } else {
          append(
            event.seq,
            "runtime",
            `${event.source.kind} message`,
            messageTokens(event.message),
            "estimated",
          );
        }
        break;
      case "context_compacted":
        if (event.beforeTokens !== undefined && event.afterTokens !== undefined) {
          if (event.beforeTokens > peakContextTokens) {
            peakContextTokens = event.beforeTokens;
            peakContextSource = "provider";
          }
          contextTokens = event.afterTokens;
          contextSource = "provider";
          segments.push({
            seq: event.seq,
            kind: "compaction",
            label: `compact [${event.trigger}]`,
            tokens: event.afterTokens - event.beforeTokens,
            tokenSource: "provider",
            contextTokens,
            contextSource,
          });
        } else {
          warnings.push(`Compact event ${event.seq} has no token counts.`);
        }
        break;
      case "turn_completed":
        status = event.status;
        break;
      default:
        break;
    }
  }

  return {
    type: "turn_waterfall_v1",
    sessionId: meta.sessionId,
    turnId,
    status,
    peakContextTokens,
    peakContextSource,
    segments,
    warnings,
  };
}
