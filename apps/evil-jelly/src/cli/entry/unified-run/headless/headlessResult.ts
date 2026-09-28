import { createHash } from "node:crypto";
import type { ModelAdapter } from "@rejelly/core";
import {
  readSessionFacts,
  type SessionStoragePaths,
} from "../../../../domains/session/repository/sessionStore";
import { getSessionModelConfiguration } from "../../../../shared/model/observation/modelConfiguration";

export interface HeadlessResultError {
  phase: "startup" | "agent_run" | "session_finalize";
  message: string;
}

export interface WriteHeadlessResultOptions {
  resultPath: string;
  runId: string;
  sessionId: string;
  sessionStoreRoot: string;
  sessionStorage: SessionStoragePaths;
  workspaceRoot: string;
  traceId: string;
  model: ModelAdapter;
  reviewEnabled: boolean;
  input: string;
  output: string;
  status: "completed" | "error";
  terminationReason: "completed" | "agent_error" | "session_error";
  exitCode: number;
  startedAt: number;
  endedAt: number;
  error?: HeadlessResultError;
  writeResultFile: (filePath: string, content: string) => Promise<void>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function peakConcurrency(intervals: readonly { start: number; end: number }[]): number {
  const points = intervals.flatMap((interval) => [
    { at: interval.start, delta: 1 },
    { at: interval.end, delta: -1 },
  ]);
  points.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let peak = 0;
  for (const point of points) {
    active += point.delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

export async function writeHeadlessResult(options: WriteHeadlessResultOptions): Promise<void> {
  const stored = await readSessionFacts(
    options.workspaceRoot,
    options.sessionId,
    options.sessionStorage,
  );
  const modelEvents = stored.events.filter((event) => event.type === "model_call_completed");
  const toolEvents = stored.events.filter((event) => event.type === "tool_call_completed");
  const tokens = modelEvents.reduce(
    (summary, event) => ({
      prompt: summary.prompt + (event.usage?.promptTokens ?? 0),
      completion: summary.completion + (event.usage?.completionTokens ?? 0),
      reasoning: summary.reasoning + (event.usage?.reasoningTokens ?? 0),
      cacheRead: summary.cacheRead + (event.usage?.cacheReadTokens ?? 0),
      cacheWrite: summary.cacheWrite + (event.usage?.cacheWriteTokens ?? 0),
      total: summary.total + (event.usage?.totalTokens ?? 0),
    }),
    { prompt: 0, completion: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  );
  const outcomes = {
    succeeded: 0,
    failed: 0,
    denied: 0,
    aborted: 0,
    timedOut: 0,
  };
  for (const event of toolEvents) {
    const outcome = event.outcome ?? (event.transportOk ? "succeeded" : "failed");
    if (outcome === "timed_out") outcomes.timedOut += 1;
    else outcomes[outcome] += 1;
  }
  const modelConfiguration = getSessionModelConfiguration(options.model);
  const toolIntervals = toolEvents.map((event) => ({
    start: event.timestamp - event.durationMs,
    end: event.timestamp,
  }));
  const result = {
    type: "evil_run_result_v1",
    schemaVersion: 1,
    runId: options.runId,
    mode: "headless",
    status: options.status,
    terminationReason: options.terminationReason,
    exitCode: options.exitCode,
    startedAt: options.startedAt,
    endedAt: options.endedAt,
    durationMs: Math.max(0, options.endedAt - options.startedAt),
    sessions: [
      {
        sessionId: options.sessionId,
        schemaVersion: stored.meta.schemaVersion,
        workspaceRoot: options.workspaceRoot,
        storeRoot: options.sessionStoreRoot,
        traceIds: [options.traceId],
      },
    ],
    traces: [
      {
        traceId: options.traceId,
        kind: "run_segment",
        review: { enabled: options.reviewEnabled },
      },
    ],
    input: {
      source: "inline",
      sha256: sha256(options.input),
      chars: options.input.length,
      bytes: utf8Bytes(options.input),
    },
    runtime: {
      model: {
        modelId: modelConfiguration?.modelId ?? options.model.id,
        ...(options.model.provider ? { provider: options.model.provider } : {}),
        ...(modelConfiguration
          ? {
              protocol: modelConfiguration.protocol,
              endpoint: modelConfiguration.endpoint,
              ...(modelConfiguration.reasoningEffort
                ? { reasoningEffort: modelConfiguration.reasoningEffort }
                : {}),
            }
          : {}),
      },
      toolWidth: {
        availableDefinitions: Math.max(
          0,
          ...modelEvents.map((event) => event.input?.toolDefinitionCount ?? 0),
        ),
        availableSchemaBytes: Math.max(
          0,
          ...modelEvents.map((event) => event.input?.toolSchemaBytes ?? 0),
        ),
        distinctInvoked: new Set(toolEvents.map((event) => event.toolName)).size,
        totalCalls: toolEvents.length,
        peakConcurrency: peakConcurrency(toolIntervals),
      },
    },
    modelCalls: {
      calls: modelEvents.length,
      successful: modelEvents.filter((event) => event.success).length,
      failed: modelEvents.filter((event) => !event.success).length,
      retries: modelEvents.reduce((sum, event) => sum + (event.retryCount ?? 0), 0),
      durationMs: modelEvents.reduce((sum, event) => sum + event.durationMs, 0),
      tokens,
    },
    toolCalls: {
      calls: toolEvents.length,
      outcomes,
      transportFailures: toolEvents.filter((event) => !event.transportOk).length,
      distinctInvoked: new Set(toolEvents.map((event) => event.toolName)).size,
      peakConcurrency: peakConcurrency(toolIntervals),
      durationMs: {
        summed: toolEvents.reduce((sum, event) => sum + event.durationMs, 0),
      },
      results: {
        rawBytes: toolEvents.reduce((sum, event) => sum + event.outputBytes, 0),
        admittedBytes: toolEvents.reduce((sum, event) => sum + (event.admittedResultBytes ?? 0), 0),
        truncatedCalls: toolEvents.filter((event) => event.truncated).length,
      },
    },
    output: {
      text: options.output,
      sha256: sha256(options.output),
      chars: options.output.length,
      bytes: utf8Bytes(options.output),
      truncated: false,
    },
    error: options.error ?? null,
    warnings: stored.warnings.map((warning) => ({
      offset: warning.offset,
      byteLength: warning.byteLength,
    })),
  };
  await options.writeResultFile(options.resultPath, `${JSON.stringify(result, null, 2)}\n`);
}
