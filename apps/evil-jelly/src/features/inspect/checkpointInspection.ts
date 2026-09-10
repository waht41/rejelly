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
  /** Non-negative allocation reconciled to the first provider input. */
  tokens: number;
  /** Independent local estimate before reconciliation. */
  estimatedTokens: number;
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
  /** Provider prompt minus estimated current-turn input before the first call. */
  tokens: number;
  tokenSource: "estimated";
  providerPromptTokens: number;
  estimatedTurnInputTokens: number;
  estimatedNamedComponentTokens: number;
  reconciliationDeltaTokens: number;
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

function reconcileNamedComponents(
  estimates: readonly Omit<InitialContextComponentInspection, "tokens" | "share">[],
  totalTokens: number,
): InitialContextComponentInspection[] {
  const estimatedTotal = estimates.reduce((sum, component) => sum + component.estimatedTokens, 0);
  if (estimatedTotal <= totalTokens) {
    return estimates.map((component) => ({
      ...component,
      tokens: component.estimatedTokens,
      share: share(component.estimatedTokens, totalTokens),
    }));
  }

  let remainingTokens = totalTokens;
  let remainingEstimate = estimatedTotal;
  return estimates.map((component, index) => {
    const tokens =
      index === estimates.length - 1
        ? remainingTokens
        : Math.min(
            remainingTokens,
            Math.round((remainingTokens * component.estimatedTokens) / remainingEstimate),
          );
    remainingTokens -= tokens;
    remainingEstimate -= component.estimatedTokens;
    return { ...component, tokens, share: share(tokens, totalTokens) };
  });
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
  const namedEstimates = [
    {
      kind: "system_instructions" as const,
      label: "system instructions",
      estimatedTokens: estimateAsciiTokens(input?.systemPromptChars ?? 0),
    },
    {
      kind: "tool_definitions" as const,
      label: "tool definitions",
      estimatedTokens: estimateAsciiTokens(input?.toolSchemaBytes ?? 0),
    },
    {
      kind: "prior_conversation" as const,
      label: "prior conversation",
      estimatedTokens: estimateMessagesTokens(activeHistoryBeforeTurn(events, waterfall.turnId)),
    },
  ];
  const estimatedNamedComponentTokens = namedEstimates.reduce(
    (sum, component) => sum + component.estimatedTokens,
    0,
  );
  const reconciliationDeltaTokens = totalTokens - estimatedNamedComponentTokens;
  const components = reconcileNamedComponents(namedEstimates, totalTokens);
  if (reconciliationDeltaTokens > 0) {
    components.push({
      kind: "other",
      label: "unattributed / reconciliation",
      tokens: reconciliationDeltaTokens,
      estimatedTokens: reconciliationDeltaTokens,
      share: share(reconciliationDeltaTokens, totalTokens),
    });
  }

  const warnings: string[] = [];
  if (!input) {
    warnings.push("The first model call has no persisted input composition metrics.");
  }
  if (checkpoint.adjustmentTokens < 0) {
    warnings.push(
      "The estimated current-turn input exceeded the first provider prompt; Initial context was clamped to zero.",
    );
  }
  if (reconciliationDeltaTokens < 0) {
    warnings.push(
      `Estimated named components (${estimatedNamedComponentTokens} tokens) exceed reconciled Initial context (${totalTokens} tokens); displayed component tokens were proportionally scaled to fit.`,
    );
  }
  const toolTokens =
    components.find((component) => component.kind === "tool_definitions")?.tokens ?? 0;
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
    providerPromptTokens: checkpoint.promptTokens,
    estimatedTurnInputTokens: checkpoint.estimatedContextTokens,
    estimatedNamedComponentTokens,
    reconciliationDeltaTokens,
    components,
    ...(toolDefinitions ? { toolDefinitions } : {}),
    warnings,
  };
}

export function dumpInitialContextInspection(inspection: InitialContextInspection): string {
  return JSON.stringify(inspection, null, 2);
}
