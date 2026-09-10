import type { Message } from "@rejelly/core";
import {
  isKnownSessionEvent,
  type ModelCallCompletedEvent,
  type SessionEvent,
  type SessionMetaLine,
} from "../../domains/session/model/sessionEvents";
import { estimateMessagesTokens } from "../../shared/model/budget/tokenEstimate";
import { projectFrozenUserInputMessage } from "../../shared/model/prompt/frozenUserInput";
import type { TurnWaterfallInspection } from "./turnWaterfall";

export interface InitialContextComponentInspection {
  kind: "system_instructions" | "tool_definitions" | "prior_conversation" | "other";
  label: string;
  tokens: number;
  share: number;
}

export interface ToolDefinitionInspection {
  name: string;
  tokens: number;
  share: number;
}

export interface InitialContextInspection {
  type: "initial_context_inspection_v1";
  sessionId: string;
  turnId: string;
  address: "C1";
  tokens: number;
  tokenSource: "estimated";
  components: InitialContextComponentInspection[];
  toolDefinitions?: ToolDefinitionInspection[];
  warnings: string[];
}

function estimateAsciiTokens(charsOrBytes: number): number {
  return Math.ceil(charsOrBytes / 4);
}

function share(tokens: number, totalTokens: number): number {
  return totalTokens > 0 ? tokens / totalTokens : 0;
}

function activeHistoryBeforeTurn(events: readonly SessionEvent[], turnId: string): Message[] {
  const known = events.filter(isKnownSessionEvent).sort((left, right) => left.seq - right.seq);
  const turnStartSeq = known.reduce(
    (first, event) =>
      "turnId" in event && event.turnId === turnId ? Math.min(first, event.seq) : first,
    Number.POSITIVE_INFINITY,
  );
  let messages: Message[] = [];
  for (const event of known) {
    if (event.seq >= turnStartSeq) break;
    if (event.type === "context_compacted") {
      messages = [...event.replacementHistory];
      continue;
    }
    if (event.type === "user_input_recorded") {
      messages.push(projectFrozenUserInputMessage(event.input));
      continue;
    }
    if (event.type === "message_recorded") messages.push(event.message);
  }
  return messages.filter((message) => message.role !== "system");
}

function modelCallForCheckpoint(
  events: readonly SessionEvent[],
  turnId: string,
  seq: number,
): ModelCallCompletedEvent | undefined {
  return events.find(
    (event): event is ModelCallCompletedEvent =>
      isKnownSessionEvent(event) &&
      event.type === "model_call_completed" &&
      event.turnId === turnId &&
      event.seq === seq,
  );
}

function projectToolDefinitions(
  input: ModelCallCompletedEvent["input"],
  totalTokens: number,
): ToolDefinitionInspection[] | undefined {
  if (!input?.toolDefinitions?.length) return undefined;
  const totalWeight = input.toolDefinitions.reduce(
    (sum, definition) => sum + definition.schemaBytes,
    0,
  );
  let allocated = 0;
  return input.toolDefinitions
    .map((definition, index) => {
      const tokens =
        index === input.toolDefinitions!.length - 1
          ? totalTokens - allocated
          : totalWeight > 0
            ? Math.round((totalTokens * definition.schemaBytes) / totalWeight)
            : 0;
      allocated += tokens;
      return {
        name: definition.name,
        tokens,
        share: share(tokens, totalTokens),
      };
    })
    .sort((left, right) => right.tokens - left.tokens);
}

export function projectInitialContextInspection(
  meta: SessionMetaLine,
  events: readonly SessionEvent[],
  waterfall: TurnWaterfallInspection,
  selector: string,
): InitialContextInspection {
  if (selector.toUpperCase() !== "C1") {
    throw new Error(`Checkpoint drill-down currently supports only C1, received: ${selector}.`);
  }
  const checkpoint = waterfall.checkpoints[0];
  if (!checkpoint) throw new Error(`Turn ${waterfall.turnId} has no provider input checkpoint.`);
  const modelCall = modelCallForCheckpoint(events, waterfall.turnId, checkpoint.seq);
  const input = modelCall?.input;
  const totalTokens = Math.max(0, checkpoint.adjustmentTokens);
  const systemTokens = estimateAsciiTokens(input?.systemPromptChars ?? 0);
  const toolTokens = estimateAsciiTokens(input?.toolSchemaBytes ?? 0);
  const priorConversationTokens = estimateMessagesTokens(
    activeHistoryBeforeTurn(events, waterfall.turnId),
  );
  const otherTokens = totalTokens - systemTokens - toolTokens - priorConversationTokens;
  const warnings: string[] = [];
  if (!input) {
    warnings.push("The first model call has no persisted input composition metrics.");
  }
  if (checkpoint.adjustmentTokens < 0) {
    warnings.push(
      "The initial local estimate exceeded the provider input; Initial context was clamped to zero.",
    );
  }
  if (otherTokens < 0) {
    warnings.push(
      "Estimated components exceed Initial context; other / reconciliation is negative.",
    );
  }
  const components: InitialContextComponentInspection[] = [
    {
      kind: "system_instructions",
      label: "system instructions",
      tokens: systemTokens,
      share: share(systemTokens, totalTokens),
    },
    {
      kind: "tool_definitions",
      label: "tool definitions",
      tokens: toolTokens,
      share: share(toolTokens, totalTokens),
    },
    {
      kind: "prior_conversation",
      label: "prior conversation",
      tokens: priorConversationTokens,
      share: share(priorConversationTokens, totalTokens),
    },
    {
      kind: "other",
      label: "other / reconciliation",
      tokens: otherTokens,
      share: share(otherTokens, totalTokens),
    },
  ];
  const toolDefinitions = projectToolDefinitions(input, toolTokens);
  if (toolTokens > 0 && !toolDefinitions) {
    warnings.push("Per-Tool definition sizes were not persisted for this Session.");
  }
  return {
    type: "initial_context_inspection_v1",
    sessionId: meta.sessionId,
    turnId: waterfall.turnId,
    address: "C1",
    tokens: totalTokens,
    tokenSource: "estimated",
    components,
    ...(toolDefinitions ? { toolDefinitions } : {}),
    warnings,
  };
}

export function dumpInitialContextInspection(inspection: InitialContextInspection): string {
  return JSON.stringify(inspection, null, 2);
}
