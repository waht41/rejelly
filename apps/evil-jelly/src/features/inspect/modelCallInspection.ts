import {
  isKnownSessionEvent,
  type ModelCallCompletedEvent,
  type SessionEvent,
  type SessionMetaLine,
} from "../../domains/session/model/sessionEvents";
import { type PromptMetrics, projectPromptMetrics } from "./promptMetrics";

export type ModelCallView = "balanced" | "tokens" | "latency" | "transport";

export interface ModelCallInputInspection {
  messagesByRole: { system: number; user: number; assistant: number; tool: number };
  messageChars: number;
  systemPromptChars: number;
  toolResultChars: number;
  toolDefinitionCount: number;
  toolSchemaBytes: number;
  toolDefinitions?: Array<{ name: string; schemaBytes: number }>;
}

export interface ModelCallInspection {
  type: "model_call_inspection_v1";
  sessionId: string;
  address: string;
  ordinal: number;
  seq: number;
  timestamp: number;
  turnId?: string;
  turnNumber?: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  model: ModelCallCompletedEvent["model"];
  messageCount: number;
  input?: ModelCallInputInspection;
  usedTools: boolean;
  durationMs: number;
  ttftMs?: number;
  generationMs?: number;
  finishReason?: string;
  status: "succeeded" | "failed";
  errorCode?: string;
  usage?: ModelCallCompletedEvent["usage"];
  uncachedTokens?: number;
  cacheHitRate?: number;
  costs?: Record<string, number>;
  attemptCount: number;
  retryCount: number;
  totalRetryDelayMs?: number;
  attempts?: NonNullable<ModelCallCompletedEvent["attempts"]>;
}

export interface ModelCallSummary {
  calls: number;
  successful: number;
  failed: number;
  retries: number;
  prompt: PromptMetrics;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number;
  durationMs: number;
  averageDurationMs: number;
  p50DurationMs?: number;
  p95DurationMs?: number;
  measuredTtftCalls: number;
  p50TtftMs?: number;
  p95TtftMs?: number;
}

export interface NotableModelCall {
  call: ModelCallInspection;
  reasons: string[];
}

export interface ModelCallListInspection {
  type: "model_call_list_v1";
  sessionId: string;
  scope: "session" | "turn" | "range";
  turnId?: string;
  selector?: string;
  summary: ModelCallSummary;
  calls: ModelCallInspection[];
  notableCalls: NotableModelCall[];
}

function percentile(values: readonly number[], fraction: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function turnNumbers(events: readonly SessionEvent[]): Map<string, number> {
  const firstSeq = new Map<string, number>();
  for (const event of events) {
    if (!isKnownSessionEvent(event)) continue;
    const turnId =
      "turnId" in event && typeof event.turnId === "string"
        ? event.turnId
        : event.type === "context_compacted"
          ? event.activeTurnId
          : undefined;
    if (turnId && !firstSeq.has(turnId)) firstSeq.set(turnId, event.seq);
  }
  return new Map(
    [...firstSeq.entries()]
      .sort((left, right) => left[1] - right[1])
      .map(([turnId], index) => [turnId, index + 1]),
  );
}

export function projectModelCalls(
  meta: SessionMetaLine,
  events: readonly SessionEvent[],
): ModelCallInspection[] {
  const numbers = turnNumbers(events);
  const calls: ModelCallInspection[] = [];
  for (const event of events) {
    if (!isKnownSessionEvent(event) || event.type !== "model_call_completed") continue;
    const ordinal = calls.length + 1;
    const promptTokens = event.usage?.promptTokens;
    const cacheReadTokens = event.usage?.cacheReadTokens ?? 0;
    const retryCount = event.retryCount ?? Math.max(0, (event.attemptCount ?? 1) - 1);
    const attemptCount = event.attemptCount ?? retryCount + 1;
    calls.push({
      type: "model_call_inspection_v1",
      sessionId: meta.sessionId,
      address: `M${ordinal}`,
      ordinal,
      seq: event.seq,
      timestamp: event.timestamp,
      ...(event.turnId ? { turnId: event.turnId, turnNumber: numbers.get(event.turnId) } : {}),
      traceId: event.traceId,
      spanId: event.spanId,
      ...(event.parentSpanId ? { parentSpanId: event.parentSpanId } : {}),
      model: event.model,
      messageCount: event.messageCount,
      ...(event.input ? { input: event.input } : {}),
      usedTools: event.usedTools,
      durationMs: event.durationMs,
      ...(event.ttftMs !== undefined
        ? {
            ttftMs: event.ttftMs,
            generationMs: Math.max(0, event.durationMs - event.ttftMs),
          }
        : {}),
      ...(event.finishReason ? { finishReason: event.finishReason } : {}),
      status: event.success ? "succeeded" : "failed",
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      ...(event.usage ? { usage: event.usage } : {}),
      ...(promptTokens !== undefined
        ? {
            uncachedTokens: Math.max(0, promptTokens - cacheReadTokens),
            cacheHitRate: promptTokens > 0 ? cacheReadTokens / promptTokens : 0,
          }
        : {}),
      ...(event.costs ? { costs: event.costs } : {}),
      attemptCount,
      retryCount,
      ...(event.totalRetryDelayMs !== undefined
        ? { totalRetryDelayMs: event.totalRetryDelayMs }
        : {}),
      ...(event.attempts ? { attempts: event.attempts } : {}),
    });
  }
  return calls;
}

function summarize(calls: readonly ModelCallInspection[]): ModelCallSummary {
  const prompt = projectPromptMetrics(
    calls.map((call) => ({
      promptTokens: call.usage?.promptTokens,
      cacheReadTokens: call.usage?.cacheReadTokens,
    })),
  );
  const durationMs = calls.reduce((sum, call) => sum + call.durationMs, 0);
  const cacheReadTokens = calls.reduce((sum, call) => sum + (call.usage?.cacheReadTokens ?? 0), 0);
  const ttfts = calls.flatMap((call) => (call.ttftMs === undefined ? [] : [call.ttftMs]));
  return {
    calls: calls.length,
    successful: calls.filter((call) => call.status === "succeeded").length,
    failed: calls.filter((call) => call.status === "failed").length,
    retries: calls.reduce((sum, call) => sum + call.retryCount, 0),
    prompt,
    completionTokens: calls.reduce((sum, call) => sum + (call.usage?.completionTokens ?? 0), 0),
    reasoningTokens: calls.reduce((sum, call) => sum + (call.usage?.reasoningTokens ?? 0), 0),
    cacheReadTokens,
    cacheWriteTokens: calls.reduce((sum, call) => sum + (call.usage?.cacheWriteTokens ?? 0), 0),
    cacheHitRate: prompt.cumulativeTokens > 0 ? cacheReadTokens / prompt.cumulativeTokens : 0,
    durationMs,
    averageDurationMs: calls.length > 0 ? durationMs / calls.length : 0,
    p50DurationMs: percentile(
      calls.map((call) => call.durationMs),
      0.5,
    ),
    p95DurationMs: percentile(
      calls.map((call) => call.durationMs),
      0.95,
    ),
    measuredTtftCalls: ttfts.length,
    p50TtftMs: percentile(ttfts, 0.5),
    p95TtftMs: percentile(ttfts, 0.95),
  };
}

function notableCalls(
  calls: readonly ModelCallInspection[],
  summary: ModelCallSummary,
): NotableModelCall[] {
  const selected = new Map<number, NotableModelCall>();
  const add = (call: ModelCallInspection, reason: string): void => {
    const existing = selected.get(call.ordinal);
    if (existing) existing.reasons.push(reason);
    else selected.set(call.ordinal, { call, reasons: [reason] });
  };

  for (const call of calls) {
    if (call.status === "failed") add(call, call.errorCode ?? "failed");
    if (call.retryCount > 0) add(call, `${call.retryCount} retries`);
  }
  const slowThreshold = summary.p95DurationMs;
  if (slowThreshold !== undefined) {
    for (const call of calls.filter((candidate) => candidate.durationMs >= slowThreshold).slice(-3))
      add(call, "slow");
  }
  const ttftThreshold = summary.p95TtftMs;
  if (ttftThreshold !== undefined) {
    for (const call of calls
      .filter((candidate) => (candidate.ttftMs ?? -1) >= ttftThreshold)
      .slice(-3))
      add(call, "high TTFT");
  }
  for (const call of [...calls]
    .filter((candidate) => (candidate.uncachedTokens ?? 0) > 0)
    .sort((left, right) => (right.uncachedTokens ?? 0) - (left.uncachedTokens ?? 0))
    .slice(0, 3)) {
    if ((call.cacheHitRate ?? 1) < 0.8) add(call, "cache miss");
  }

  return [...selected.values()]
    .sort((left, right) => {
      const failed = Number(right.call.status === "failed") - Number(left.call.status === "failed");
      if (failed !== 0) return failed;
      const retried = right.call.retryCount - left.call.retryCount;
      if (retried !== 0) return retried;
      return right.call.durationMs - left.call.durationMs;
    })
    .slice(0, 8);
}

function parseAddress(selector: string): number {
  const match = /^M?([1-9]\d*)$/i.exec(selector.trim());
  if (!match) throw new Error(`Invalid Model Call address: ${selector}. Expected M1 or 1.`);
  return Number(match[1]);
}

function selectCalls(
  calls: readonly ModelCallInspection[],
  selector: string,
): ModelCallInspection[] {
  const single = /^\s*M?([1-9]\d*)\s*$/i.exec(selector);
  if (single) {
    const ordinal = Number(single[1]);
    const call = calls[ordinal - 1];
    if (!call) {
      throw new Error(
        `Model Call M${ordinal} is outside this Session (available: M1..M${calls.length}).`,
      );
    }
    return [call];
  }

  const range = /^\s*(M?[1-9]\d*)\.\.(M?[1-9]\d*)\s*$/i.exec(selector);
  if (!range) {
    throw new Error(
      `Invalid Model Call selector: ${selector}. Expected M16, 16, M80..M100, or 80..100.`,
    );
  }
  const first = parseAddress(range[1]);
  const last = parseAddress(range[2]);
  if (first > last)
    throw new Error(`Invalid Model Call range: ${selector}. Start must not exceed end.`);
  const selected = calls.filter((call) => call.ordinal >= first && call.ordinal <= last);
  if (selected.length !== last - first + 1) {
    throw new Error(
      `Model Call range ${selector} is outside this Session (available: M1..M${calls.length}).`,
    );
  }
  return selected;
}

export function projectModelCallList(
  meta: SessionMetaLine,
  events: readonly SessionEvent[],
  options: { turnId?: string; selector?: string } = {},
): ModelCallListInspection {
  const allCalls = projectModelCalls(meta, events);
  const calls = options.selector
    ? selectCalls(allCalls, options.selector)
    : options.turnId
      ? allCalls.filter((call) => call.turnId === options.turnId)
      : allCalls;
  if (options.turnId && calls.length === 0) {
    throw new Error(`No Model Calls found in Turn ${options.turnId}.`);
  }
  const summary = summarize(calls);
  return {
    type: "model_call_list_v1",
    sessionId: meta.sessionId,
    scope: options.selector ? "range" : options.turnId ? "turn" : "session",
    ...(options.turnId ? { turnId: options.turnId } : {}),
    ...(options.selector ? { selector: options.selector } : {}),
    summary,
    calls,
    notableCalls: notableCalls(calls, summary),
  };
}

export function projectModelCallInspection(
  meta: SessionMetaLine,
  events: readonly SessionEvent[],
  selector: string,
): ModelCallInspection {
  const calls = projectModelCalls(meta, events);
  const ordinal = parseAddress(selector);
  const call = calls[ordinal - 1];
  if (!call) {
    throw new Error(
      `Model Call M${ordinal} not found in Session ${meta.sessionId}; available: M1..M${calls.length}.`,
    );
  }
  return call;
}
