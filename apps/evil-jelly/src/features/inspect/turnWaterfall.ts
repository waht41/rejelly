import type { Message } from "@rejelly/core";
import {
  isKnownSessionEvent,
  type SessionEvent,
  type SessionMetaLine,
} from "../../domains/session/model/sessionEvents";
import { estimateMessagesTokens } from "../../shared/model/budget/tokenEstimate";
import { projectFrozenUserInputMessage } from "../../shared/model/prompt/frozenUserInput";
import { type PromptMetrics, projectPromptMetrics } from "./promptMetrics";

export type TurnWaterfallSegmentKind =
  | "user"
  | "reasoning"
  | "assistant"
  | "tool_request"
  | "tool_result"
  | "compaction"
  | "runtime";

export interface TurnWaterfallChild {
  label: string;
  toolCallId?: string;
  tokens: number;
  tokenSource: "estimated";
  contextTokens: number;
  contextSource: "estimated";
}

export interface TurnWaterfallSegment {
  seq: number;
  kind: TurnWaterfallSegmentKind;
  label: string;
  toolCallId?: string;
  tokens: number;
  tokenSource: "provider" | "estimated";
  contextTokens: number;
  contextSource: "provider" | "estimated";
  children?: TurnWaterfallChild[];
}

export interface TurnWaterfallCheckpoint {
  seq: number;
  modelCallNumber: number;
  modelCallAddress: string;
  promptTokens: number;
  estimatedContextTokens: number;
  adjustmentTokens: number;
}

export interface TurnWaterfallInspection {
  type: "turn_waterfall_v2";
  sessionId: string;
  turnId: string;
  status: "in_progress" | "completed" | "interrupted" | "error";
  peakContextTokens: number;
  peakContextSource: "provider" | "estimated";
  prompt: PromptMetrics;
  checkpoints: TurnWaterfallCheckpoint[];
  segments: TurnWaterfallSegment[];
  warnings: string[];
}

export interface TurnWaterfallTopContributor {
  address: string;
  label: string;
  toolCallId?: string;
  tokens: number;
  tokenSource: "provider" | "estimated";
  share: number;
}

export interface SessionTopContributor extends TurnWaterfallTopContributor {
  turnId: string;
  turnNumber: number;
}

export interface ResolvedWaterfallSegment {
  address: string;
  segmentNumber: number;
  childNumber?: number;
  segment: TurnWaterfallSegment | TurnWaterfallChild;
  parent: TurnWaterfallSegment;
}

export function resolveWaterfallSegment(
  waterfall: TurnWaterfallInspection,
  selector: string,
): ResolvedWaterfallSegment {
  const match = /^([1-9]\d*)(?:\.([1-9]\d*))?$/.exec(selector);
  if (!match) throw new Error(`Invalid segment address: ${selector}. Expected N or N.M.`);
  const segmentNumber = Number(match[1]);
  const childNumber = match[2] ? Number(match[2]) : undefined;
  const parent = waterfall.segments[segmentNumber - 1];
  if (!parent) throw new Error(`Segment ${segmentNumber} not found in Turn ${waterfall.turnId}.`);
  if (childNumber === undefined) {
    return { address: String(segmentNumber), segmentNumber, segment: parent, parent };
  }
  const child = parent.children?.[childNumber - 1];
  if (!child) throw new Error(`Segment ${selector} not found in Turn ${waterfall.turnId}.`);
  return {
    address: `${segmentNumber}.${childNumber}`,
    segmentNumber,
    childNumber,
    segment: child,
    parent,
  };
}

function messageTokens(message: Message): number {
  return estimateMessagesTokens([message]);
}

function allocateParallelToolTokens(
  totalTokens: number,
  calls: NonNullable<Message["tool_calls"]>,
  initialContextTokens: number,
): TurnWaterfallChild[] {
  const weights = calls.map((call) =>
    Math.max(1, messageTokens({ role: "assistant", content: null, tool_calls: [call] })),
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let allocatedTokens = 0;
  let childContextTokens = initialContextTokens;
  return calls.map((call, index) => {
    const tokens =
      index === calls.length - 1
        ? totalTokens - allocatedTokens
        : Math.round((totalTokens * weights[index]) / totalWeight);
    allocatedTokens += tokens;
    childContextTokens += tokens;
    return {
      label: `${call.name} request`,
      toolCallId: call.id,
      tokens,
      tokenSource: "estimated",
      contextTokens: childContextTokens,
      contextSource: "estimated",
    };
  });
}

export function projectTurnWaterfall(
  meta: SessionMetaLine,
  events: readonly SessionEvent[],
  turnId: string,
): TurnWaterfallInspection {
  const known = events.filter(isKnownSessionEvent);
  const modelCallAddresses = new Map<number, string>();
  let globalModelCallNumber = 0;
  for (const event of known) {
    if (event.type === "model_call_completed") {
      globalModelCallNumber += 1;
      modelCallAddresses.set(event.seq, `M${globalModelCallNumber}`);
    }
  }
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

  const checkpoints: TurnWaterfallCheckpoint[] = [];
  const segments: TurnWaterfallSegment[] = [];
  const warnings: string[] = [];
  const parallelToolBatchByCall = new Map<string, string>();
  let activeToolResultBatch:
    | { modelCallAddress: string; segment: TurnWaterfallSegment }
    | undefined;
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
    toolCallId?: string,
  ) => {
    activeToolResultBatch = undefined;
    contextTokens = Math.max(0, contextTokens + tokens);
    if (tokenSource === "estimated") contextSource = "estimated";
    if (contextTokens > peakContextTokens) {
      peakContextTokens = contextTokens;
      peakContextSource = contextSource;
    } else if (contextTokens === peakContextTokens && contextSource === "estimated") {
      peakContextSource = "estimated";
    }
    segments.push({
      seq,
      kind,
      label,
      ...(toolCallId ? { toolCallId } : {}),
      tokens,
      tokenSource,
      contextTokens,
      contextSource,
    });
  };

  const appendParallelToolResult = (
    seq: number,
    modelCallAddress: string,
    label: string,
    toolCallId: string,
    tokens: number,
  ): void => {
    contextTokens = Math.max(0, contextTokens + tokens);
    contextSource = "estimated";
    if (contextTokens >= peakContextTokens) {
      peakContextTokens = contextTokens;
      peakContextSource = "estimated";
    }
    if (activeToolResultBatch?.modelCallAddress !== modelCallAddress) {
      const segment: TurnWaterfallSegment = {
        seq,
        kind: "tool_result",
        label: "parallel tool results",
        tokens: 0,
        tokenSource: "estimated",
        contextTokens,
        contextSource: "estimated",
        children: [],
      };
      segments.push(segment);
      activeToolResultBatch = { modelCallAddress, segment };
    }
    const segment = activeToolResultBatch.segment;
    segment.tokens += tokens;
    segment.contextTokens = contextTokens;
    segment.children!.push({
      label,
      toolCallId,
      tokens,
      tokenSource: "estimated",
      contextTokens,
      contextSource: "estimated",
    });
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
        activeToolResultBatch = undefined;
        const promptTokens = event.usage?.promptTokens;
        if (promptTokens !== undefined) {
          const estimatedContextTokens = contextTokens;
          const adjustmentTokens = promptTokens - estimatedContextTokens;
          checkpoints.push({
            seq: event.seq,
            modelCallNumber: modelIndex + 1,
            modelCallAddress: modelCallAddresses.get(event.seq)!,
            promptTokens,
            estimatedContextTokens,
            adjustmentTokens,
          });
          if (modelIndex === 0) {
            for (const segment of segments) {
              segment.contextTokens = Math.max(0, segment.contextTokens + adjustmentTokens);
              segment.contextSource = "estimated";
              for (const child of segment.children ?? []) {
                child.contextTokens = Math.max(0, child.contextTokens + adjustmentTokens);
                child.contextSource = "estimated";
              }
            }
          }
          contextTokens = promptTokens;
          contextSource = "provider";
          if (contextTokens > peakContextTokens) {
            peakContextTokens = contextTokens;
            peakContextSource = "provider";
          }
        }
        const usage = event.usage;
        const modelMessage = modelMessages[modelIndex];
        const modelCallAddress = modelCallAddresses.get(event.seq)!;
        const modelToolCalls = modelMessage?.tool_calls ?? [];
        if (modelToolCalls.length > 1) {
          for (const call of modelToolCalls) parallelToolBatchByCall.set(call.id, modelCallAddress);
        }
        const reasoningTokens = usage?.reasoningTokens ?? 0;
        if (reasoningTokens > 0)
          append(event.seq, "reasoning", "reasoning", reasoningTokens, "provider");
        const visibleTokens = Math.max(0, (usage?.completionTokens ?? 0) - reasoningTokens);
        if (visibleTokens > 0) {
          const calls = modelMessage?.tool_calls ?? [];
          const initialContextTokens = contextTokens;
          append(
            event.seq,
            calls.length > 0 ? "tool_request" : "assistant",
            calls.length > 1
              ? "parallel tool requests"
              : calls.length === 1
                ? `${calls[0].name} request`
                : "assistant answer",
            visibleTokens,
            "provider",
            calls.length === 1 ? calls[0].id : undefined,
          );
          if (calls.length > 1) {
            segments.at(-1)!.children = allocateParallelToolTokens(
              visibleTokens,
              calls,
              initialContextTokens,
            );
          }
        }
        modelIndex += 1;
        break;
      }
      case "message_recorded":
        if (event.source.kind === "model") {
          activeToolResultBatch = undefined;
          break;
        }
        if (event.message.role === "tool") {
          const toolCallId = event.message.tool_call_id ?? "";
          const resultLabel = `${toolNames.get(toolCallId) ?? event.message.name ?? "tool"} result`;
          const resultTokens = messageTokens(event.message);
          const batchAddress = parallelToolBatchByCall.get(toolCallId);
          if (batchAddress && toolCallId) {
            appendParallelToolResult(
              event.seq,
              batchAddress,
              resultLabel,
              toolCallId,
              resultTokens,
            );
          } else {
            append(
              event.seq,
              "tool_result",
              resultLabel,
              resultTokens,
              "estimated",
              event.message.tool_call_id,
            );
          }
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
        activeToolResultBatch = undefined;
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
    type: "turn_waterfall_v2",
    sessionId: meta.sessionId,
    turnId,
    status,
    peakContextTokens,
    peakContextSource,
    prompt: projectPromptMetrics(
      turnEvents.flatMap((event) =>
        event.type === "model_call_completed"
          ? [
              {
                promptTokens: event.usage?.promptTokens,
                cacheReadTokens: event.usage?.cacheReadTokens,
              },
            ]
          : [],
      ),
    ),
    checkpoints,
    segments,
    warnings,
  };
}

type TopContributorCandidate = Omit<TurnWaterfallTopContributor, "share">;

function projectTopContributorCandidates(
  inspection: TurnWaterfallInspection,
): TopContributorCandidate[] {
  return inspection.segments.flatMap((segment, segmentIndex) => {
    if (segment.children?.length) {
      return segment.children.map((child, childIndex) => ({
        address: `${segmentIndex + 1}.${childIndex + 1}`,
        label: child.label,
        ...(child.toolCallId ? { toolCallId: child.toolCallId } : {}),
        tokens: child.tokens,
        tokenSource: child.tokenSource,
      }));
    }
    if (segment.tokens <= 0) return [];
    return [
      {
        address: String(segmentIndex + 1),
        label: segment.label,
        ...(segment.toolCallId ? { toolCallId: segment.toolCallId } : {}),
        tokens: segment.tokens,
        tokenSource: segment.tokenSource,
      },
    ];
  });
}

export function projectTopContributors(
  inspection: TurnWaterfallInspection,
  limit: number,
): TurnWaterfallTopContributor[] {
  const contributors = projectTopContributorCandidates(inspection);
  const totalTokens = contributors.reduce((sum, contributor) => sum + contributor.tokens, 0);
  return contributors
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, limit)
    .map((contributor) => ({
      ...contributor,
      share: totalTokens > 0 ? contributor.tokens / totalTokens : 0,
    }));
}

export function projectSessionTopContributors(
  inspections: readonly TurnWaterfallInspection[],
  limit: number,
): SessionTopContributor[] {
  const contributors = inspections.flatMap((inspection, turnIndex) =>
    projectTopContributorCandidates(inspection).map((contributor) => ({
      ...contributor,
      turnId: inspection.turnId,
      turnNumber: turnIndex + 1,
    })),
  );
  const totalTokens = contributors.reduce((sum, contributor) => sum + contributor.tokens, 0);
  return contributors
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, limit)
    .map((contributor) => ({
      ...contributor,
      share: totalTokens > 0 ? contributor.tokens / totalTokens : 0,
    }));
}
