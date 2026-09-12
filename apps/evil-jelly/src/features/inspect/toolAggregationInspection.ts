import {
  isKnownSessionEvent,
  type SessionEvent,
  type SessionMetaLine,
} from "../../domains/session/model/sessionEvents";
import { projectToolCallInspection, type ToolCallInspection } from "./toolCallInspection";
import { projectTurnWaterfall } from "./turnWaterfall";

export interface AggregatedToolCall {
  ordinal: number;
  toolCallId: string;
  toolName: string;
  turnId?: string;
  turnNumber?: number;
  status: ToolCallInspection["status"];
  requestTokens: number;
  resultTokens: number;
  resultLines: number;
  durationMs?: number;
  completedAt?: number;
  truncated: boolean;
  grepSearch?: ToolCallInspection["grepSearch"];
}

export interface ToolAggregateSummary {
  calls: number;
  successful: number;
  failed: number;
  successRate?: number;
  requestTokens: number;
  resultTokens: number;
  totalTokens: number;
  averageResultTokens: number;
  p50ResultTokens: number;
  p95ResultTokens: number;
  maxResultTokens: number;
  resultRequestRatio?: number;
  durationSamples: number;
  summedDurationMs: number;
  wallDurationMs: number;
  averageDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  truncationRate: number;
}

export interface ToolTypeAggregate extends ToolAggregateSummary {
  toolName: string;
}

export interface GrepAggregateSummary {
  measuredCalls: number;
  matches: number;
  averageMatches: number;
  p95Matches: number;
  files: number;
  emittedLines: number;
  averageEmittedLines: number;
  p50ContextLines: number;
  p95ContextLines: number;
  omittedMatches: number;
  omittedMatchesMeasuredCalls: number;
  toolTruncated: number;
  toolTruncationMeasuredCalls: number;
  canonicalComplete: number;
  linesPerMatch?: number;
}

export interface ToolAggregationInspection {
  type: "tool_aggregation_v1";
  sessionId: string;
  scope: "session" | "turn" | "tool" | "turn_tool";
  turnId?: string;
  toolName?: string;
  summary: ToolAggregateSummary;
  grepSearch?: GrepAggregateSummary;
  tools: ToolTypeAggregate[];
  unusedTools: string[];
  calls: AggregatedToolCall[];
  largestCalls: AggregatedToolCall[];
  failedCalls: AggregatedToolCall[];
}

interface CallIdentity {
  toolCallId: string;
  toolName?: string;
  turnId?: string;
  firstSeq: number;
  firstTimestamp: number;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function wallDuration(calls: readonly AggregatedToolCall[]): number {
  const intervals = calls
    .filter(
      (call): call is AggregatedToolCall & { completedAt: number; durationMs: number } =>
        call.completedAt !== undefined && call.durationMs !== undefined,
    )
    .map((call) => ({ start: call.completedAt - call.durationMs, end: call.completedAt }))
    .sort((left, right) => left.start - right.start);
  if (intervals.length === 0) return 0;
  let total = 0;
  let start = intervals[0].start;
  let end = intervals[0].end;
  for (const interval of intervals.slice(1)) {
    if (interval.start <= end) {
      end = Math.max(end, interval.end);
      continue;
    }
    total += end - start;
    start = interval.start;
    end = interval.end;
  }
  return total + end - start;
}

function summarize(calls: readonly AggregatedToolCall[]): ToolAggregateSummary {
  const successful = calls.filter((call) => call.status === "succeeded").length;
  const failed = calls.filter(
    (call) => call.status !== "succeeded" && call.status !== "pending",
  ).length;
  const requestTokens = calls.reduce((sum, call) => sum + call.requestTokens, 0);
  const resultTokens = calls.reduce((sum, call) => sum + call.resultTokens, 0);
  const resultSizes = calls.map((call) => call.resultTokens);
  const durations = calls.flatMap((call) =>
    call.durationMs === undefined ? [] : [call.durationMs],
  );
  const summedDurationMs = durations.reduce((sum, value) => sum + value, 0);
  return {
    calls: calls.length,
    successful,
    failed,
    ...(successful + failed > 0 ? { successRate: successful / (successful + failed) } : {}),
    requestTokens,
    resultTokens,
    totalTokens: requestTokens + resultTokens,
    averageResultTokens: calls.length === 0 ? 0 : resultTokens / calls.length,
    p50ResultTokens: percentile(resultSizes, 0.5),
    p95ResultTokens: percentile(resultSizes, 0.95),
    maxResultTokens: resultSizes.length === 0 ? 0 : Math.max(...resultSizes),
    ...(requestTokens > 0 ? { resultRequestRatio: resultTokens / requestTokens } : {}),
    durationSamples: durations.length,
    summedDurationMs,
    wallDurationMs: wallDuration(calls),
    averageDurationMs: durations.length === 0 ? 0 : summedDurationMs / durations.length,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    truncationRate:
      calls.length === 0 ? 0 : calls.filter((call) => call.truncated).length / calls.length,
  };
}

function summarizeGrep(calls: readonly AggregatedToolCall[]): GrepAggregateSummary | undefined {
  const measured = calls.flatMap((call) => (call.grepSearch ? [call.grepSearch] : []));
  if (measured.length === 0) return undefined;
  const matchesByCall = measured.map((search) => search.matches);
  const contextByCall = measured.map((search) => search.contextLines);
  const matches = matchesByCall.reduce((sum, value) => sum + value, 0);
  const emittedLines = measured.reduce((sum, search) => sum + search.emittedLines, 0);
  const omittedMeasured = measured.filter((search) => search.omittedMatches !== undefined);
  const truncationMeasured = measured.filter((search) => search.truncated !== undefined);
  return {
    measuredCalls: measured.length,
    matches,
    averageMatches: matches / measured.length,
    p95Matches: percentile(matchesByCall, 0.95),
    files: measured.reduce((sum, search) => sum + search.files, 0),
    emittedLines,
    averageEmittedLines: emittedLines / measured.length,
    p50ContextLines: percentile(contextByCall, 0.5),
    p95ContextLines: percentile(contextByCall, 0.95),
    omittedMatches: omittedMeasured.reduce((sum, search) => sum + (search.omittedMatches ?? 0), 0),
    omittedMatchesMeasuredCalls: omittedMeasured.length,
    toolTruncated: truncationMeasured.filter((search) => search.truncated).length,
    toolTruncationMeasuredCalls: truncationMeasured.length,
    canonicalComplete: calls.filter((call) => !call.truncated).length,
    ...(matches > 0 ? { linesPerMatch: emittedLines / matches } : {}),
  };
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

function collectCallIdentities(events: readonly SessionEvent[]): CallIdentity[] {
  const calls = new Map<string, CallIdentity>();
  const record = (
    toolCallId: string,
    seq: number,
    timestamp: number,
    toolName?: string,
    turnId?: string,
  ): void => {
    const existing = calls.get(toolCallId);
    if (!existing) {
      calls.set(toolCallId, {
        toolCallId,
        toolName,
        turnId,
        firstSeq: seq,
        firstTimestamp: timestamp,
      });
      return;
    }
    existing.toolName ??= toolName;
    existing.turnId ??= turnId;
    if (seq < existing.firstSeq) {
      existing.firstSeq = seq;
      existing.firstTimestamp = timestamp;
    }
  };
  for (const event of events) {
    if (!isKnownSessionEvent(event)) continue;
    if (event.type === "tool_call_completed" || event.type === "tool_observation_recorded") {
      record(event.toolCallId, event.seq, event.timestamp, event.toolName, event.turnId);
    }
    if (event.type === "message_recorded") {
      for (const call of event.message.tool_calls ?? []) {
        record(call.id, event.seq, event.timestamp, call.name, event.turnId);
      }
      if (event.message.tool_call_id) {
        record(
          event.message.tool_call_id,
          event.seq,
          event.timestamp,
          event.message.name,
          event.turnId,
        );
      }
    }
  }
  return [...calls.values()].sort((left, right) => left.firstSeq - right.firstSeq);
}

export function projectToolCalls(
  meta: SessionMetaLine,
  events: readonly SessionEvent[],
): AggregatedToolCall[] {
  const numbers = turnNumbers(events);
  const completions = new Map(
    events.flatMap((event) =>
      isKnownSessionEvent(event) && event.type === "tool_call_completed"
        ? [[event.toolCallId, event] as const]
        : [],
    ),
  );
  const observations = new Map(
    events.flatMap((event) =>
      isKnownSessionEvent(event) && event.type === "tool_observation_recorded"
        ? [[event.toolCallId, event] as const]
        : [],
    ),
  );
  const waterfalls = new Map<string, ReturnType<typeof projectTurnWaterfall>>();
  return collectCallIdentities(events).map((identity, index) => {
    const completion = completions.get(identity.toolCallId);
    const observation = observations.get(identity.toolCallId);
    let inspection: ToolCallInspection | undefined;
    if (identity.turnId) {
      let waterfall = waterfalls.get(identity.turnId);
      if (!waterfall) {
        waterfall = projectTurnWaterfall(meta, events, identity.turnId);
        waterfalls.set(identity.turnId, waterfall);
      }
      inspection = projectToolCallInspection(meta, events, waterfall, identity.toolCallId);
    }
    const observedStatus =
      observation?.outcome ??
      (observation ? (observation.ok ? "succeeded" : "failed") : (inspection?.status ?? "pending"));
    const status =
      completion?.outcome ??
      (completion?.transportOk === false ? "failed" : completion ? "succeeded" : observedStatus);
    return {
      ordinal: index + 1,
      toolCallId: identity.toolCallId,
      toolName: inspection?.toolName ?? identity.toolName ?? "unknown",
      ...(identity.turnId
        ? { turnId: identity.turnId, turnNumber: numbers.get(identity.turnId) }
        : {}),
      status,
      requestTokens: inspection?.request?.tokens ?? 0,
      resultTokens: inspection?.result?.tokens ?? 0,
      resultLines: inspection?.result?.lines ?? 0,
      ...(completion
        ? { durationMs: completion.durationMs, completedAt: completion.timestamp }
        : {}),
      truncated: completion?.truncated ?? false,
      ...(inspection?.grepSearch ? { grepSearch: inspection.grepSearch } : {}),
    };
  });
}

export function projectToolAggregation(
  meta: SessionMetaLine,
  events: readonly SessionEvent[],
  options: { turnId?: string; toolName?: string; top?: number } = {},
): ToolAggregationInspection {
  const availableTools = new Set<string>();
  for (const event of events) {
    if (
      isKnownSessionEvent(event) &&
      event.type === "model_call_completed" &&
      (!options.turnId || event.turnId === options.turnId)
    ) {
      for (const definition of event.input?.toolDefinitions ?? []) {
        availableTools.add(definition.name);
      }
    }
  }
  let calls = projectToolCalls(meta, events);
  if (options.turnId) calls = calls.filter((call) => call.turnId === options.turnId);
  const calledToolNames = new Set(calls.map((call) => call.toolName));
  if (options.toolName) calls = calls.filter((call) => call.toolName === options.toolName);
  if (options.toolName && calls.length === 0) {
    const scope = options.turnId ? ` in Turn ${options.turnId}` : "";
    throw new Error(`No ${options.toolName} Tool calls found${scope}.`);
  }
  const grouped = new Map<string, AggregatedToolCall[]>();
  for (const call of calls) {
    const group = grouped.get(call.toolName) ?? [];
    group.push(call);
    grouped.set(call.toolName, group);
  }
  const tools = [...grouped.entries()]
    .map(([toolName, groupedCalls]) => ({ toolName, ...summarize(groupedCalls) }))
    .sort(
      (left, right) =>
        right.resultTokens - left.resultTokens || left.toolName.localeCompare(right.toolName),
    );
  const largestLimit = options.top ?? (options.toolName === "grep" || options.turnId ? 5 : 10);
  return {
    type: "tool_aggregation_v1",
    sessionId: meta.sessionId,
    scope: options.turnId
      ? options.toolName
        ? "turn_tool"
        : "turn"
      : options.toolName
        ? "tool"
        : "session",
    ...(options.turnId ? { turnId: options.turnId } : {}),
    ...(options.toolName ? { toolName: options.toolName } : {}),
    summary: summarize(calls),
    ...(options.toolName === "grep" ? { grepSearch: summarizeGrep(calls) } : {}),
    tools,
    unusedTools: [...availableTools]
      .filter((toolName) => !calledToolNames.has(toolName))
      .sort((left, right) => left.localeCompare(right)),
    calls,
    largestCalls: [...calls]
      .sort((left, right) => right.resultTokens - left.resultTokens || left.ordinal - right.ordinal)
      .slice(0, largestLimit),
    failedCalls: calls
      .filter((call) => call.status !== "succeeded" && call.status !== "pending")
      .slice(0, largestLimit),
  };
}
