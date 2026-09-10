import {
  EVENTS,
  type EventBus,
  getGlobalEventBus,
  type Message,
  type ModelCallEndEvent,
  type ToolsExecuteEndEvent,
} from "@rejelly/core";
import type { SessionModelConfiguration } from "../../../shared/model/observation/modelConfiguration";
import { readModelInputMetrics } from "../../../shared/model/observation/modelInputMetrics";
import { readModelRetryMetrics } from "../../../shared/model/observation/modelRetryMetrics";
import type { SessionToolObservation } from "../../../shared/session/recorderPort";
import type { SessionRecorder } from "./sessionRecorder";

export interface SessionObservationRecorderOptions {
  modelConfiguration?: Readonly<SessionModelConfiguration>;
  eventBus?: EventBus;
}

function optionalParentSpanId(parentSpanId: string): { parentSpanId?: string } {
  return parentSpanId ? { parentSpanId } : {};
}

function optionalErrorCode(event: ModelCallEndEvent): { errorCode?: string } {
  const code = event.error?.details?.code;
  return typeof code === "string" || typeof code === "number" ? { errorCode: String(code) } : {};
}

function metricText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

type PendingToolCall = Parameters<SessionRecorder["recordToolCall"]>[0];

/**
 * Run-segment-scoped bridge from Core execution events to durable Session facts.
 *
 * The Core event callback remains synchronous: projections enter a private promise queue, and
 * turn/segment closure drains that queue before writing its checkpoint.
 */
class ObservedSessionRecorder implements SessionRecorder {
  readonly sessionId: string;
  readonly traceId: string;

  readonly #eventBus: EventBus;
  readonly #unsubscribe: () => void;
  #activeTurnId: string | undefined;
  readonly #toolOutcomes = new Map<string, SessionToolObservation>();
  readonly #pendingToolCalls = new Map<string, PendingToolCall>();
  #queue: Promise<void> = Promise.resolve();
  #failure: unknown;
  #closed = false;

  constructor(
    private readonly recorder: SessionRecorder,
    private readonly options: SessionObservationRecorderOptions,
  ) {
    this.sessionId = recorder.sessionId;
    this.traceId = recorder.traceId;
    this.#eventBus = options.eventBus ?? getGlobalEventBus();
    const unsubscribeModel = this.#eventBus.subscribe(EVENTS.MODEL_CALL_END, (event) => {
      if (event.trace.traceId !== this.traceId) return;
      this.#enqueue(() => this.#recordModelCall(event, this.#activeTurnId));
    });
    const unsubscribeTools = this.#eventBus.subscribe(EVENTS.TOOLS_EXECUTE_END, (event) => {
      if (event.trace.traceId !== this.traceId) return;
      this.#captureToolCalls(event, this.#activeTurnId);
    });
    this.#unsubscribe = () => {
      unsubscribeModel();
      unsubscribeTools();
    };
  }

  get ended(): boolean {
    return this.recorder.ended;
  }

  get nextImageOrdinal(): number {
    return this.recorder.nextImageOrdinal;
  }

  #enqueue(operation: () => Promise<void>): void {
    const pending = this.#queue.then(operation);
    this.#queue = pending.catch((error) => {
      this.#failure ??= error;
    });
  }

  async #drain(): Promise<void> {
    for (const call of this.#pendingToolCalls.values()) {
      this.#enqueue(() => this.recorder.recordToolCall(call));
    }
    this.#pendingToolCalls.clear();
    await this.#queue;
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
  }

  async #recordModelCall(event: ModelCallEndEvent, turnId: string | undefined): Promise<void> {
    const config = this.options.modelConfiguration;
    const input = readModelInputMetrics(event.trace.attributes);
    const retry = readModelRetryMetrics(event.trace.attributes);
    const usage = event.usage;
    await this.recorder.recordModelCall({
      ...(turnId ? { turnId } : {}),
      traceId: event.trace.traceId,
      spanId: event.trace.spanId,
      ...optionalParentSpanId(event.trace.parentSpanId),
      model: {
        adapterId: event.adapterId,
        modelId: config?.modelId ?? event.adapterId,
        ...((event.provider ?? config?.provider)
          ? { provider: event.provider ?? config?.provider }
          : {}),
        ...(config
          ? {
              protocol: config.protocol,
              endpoint: config.endpoint,
              ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
            }
          : {}),
      },
      messageCount: event.messageCount,
      ...(input ? { input } : {}),
      usedTools: event.usedTools,
      durationMs: event.duration,
      ...(event.ttft !== undefined ? { ttftMs: event.ttft } : {}),
      ...(event.finishReason ? { finishReason: event.finishReason } : {}),
      success: event.success,
      ...optionalErrorCode(event),
      ...(usage
        ? {
            usage: {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
              ...(usage.details?.cacheReadTokens !== undefined
                ? { cacheReadTokens: usage.details.cacheReadTokens }
                : {}),
              ...(usage.details?.cacheWriteTokens !== undefined
                ? { cacheWriteTokens: usage.details.cacheWriteTokens }
                : {}),
              ...(usage.details?.reasoningTokens !== undefined
                ? { reasoningTokens: usage.details.reasoningTokens }
                : {}),
            },
          }
        : {}),
      ...(event.costs ? { costs: event.costs } : {}),
      ...(retry
        ? {
            attemptCount: retry.attempts.length,
            retryCount: Math.max(0, retry.attempts.length - 1),
            totalRetryDelayMs: retry.totalRetryDelayMs,
            attempts: retry.attempts,
          }
        : {}),
    });
  }

  #captureToolCalls(event: ToolsExecuteEndEvent, turnId: string | undefined): void {
    for (const result of event.toolResults) {
      const input = metricText(result.input);
      const output = metricText(result.output);
      const owner = this.#toolOutcomes.get(result.callId);
      this.#toolOutcomes.delete(result.callId);
      this.#pendingToolCalls.set(result.callId, {
        ...(turnId ? { turnId } : {}),
        traceId: event.trace.traceId,
        spanId: event.trace.spanId,
        ...optionalParentSpanId(event.trace.parentSpanId),
        toolCallId: result.callId,
        toolName: result.toolName,
        durationMs: result.duration,
        transportOk: result.success,
        ...(owner?.outcome ? { outcome: owner.outcome } : {}),
        ...(owner?.exitCode !== undefined ? { exitCode: owner.exitCode } : {}),
        ...(owner?.failureKind ? { failureKind: owner.failureKind } : {}),
        fromCache: result.cache ?? false,
        inputBytes: utf8Bytes(input),
        outputBytes: utf8Bytes(output),
        outputChars: output.length,
      });
    }
  }

  async #recordAdmittedToolMessage(message: Message): Promise<void> {
    if (message.role !== "tool" || !message.tool_call_id) return;
    const call = this.#pendingToolCalls.get(message.tool_call_id);
    if (!call) return;
    this.#pendingToolCalls.delete(message.tool_call_id);
    const admitted = metricText(message.content ?? "");
    const admittedResultBytes = utf8Bytes(admitted);
    await this.recorder.recordToolCall({
      ...call,
      admittedResultBytes,
      admittedResultChars: admitted.length,
      truncated: admittedResultBytes < call.outputBytes,
    });
  }

  async recordMessage(...args: Parameters<SessionRecorder["recordMessage"]>): Promise<void> {
    await this.recorder.recordMessage(...args);
    await this.#recordAdmittedToolMessage(args[2]);
  }

  async recordUserInput(...args: Parameters<SessionRecorder["recordUserInput"]>) {
    this.#activeTurnId = args[0];
    return this.recorder.recordUserInput(...args);
  }

  async recordMcpSelection(
    ...args: Parameters<SessionRecorder["recordMcpSelection"]>
  ): Promise<void> {
    await this.recorder.recordMcpSelection(...args);
  }

  async recordMcpToolGrants(
    ...args: Parameters<SessionRecorder["recordMcpToolGrants"]>
  ): Promise<void> {
    await this.recorder.recordMcpToolGrants(...args);
  }

  async recordMessages(...args: Parameters<SessionRecorder["recordMessages"]>): Promise<void> {
    await this.recorder.recordMessages(...args);
    for (const entry of args[1]) {
      await this.#recordAdmittedToolMessage(entry.message);
    }
  }

  async recordToolObservation(
    ...args: Parameters<SessionRecorder["recordToolObservation"]>
  ): Promise<void> {
    const toolCallId = args[1];
    const observation = args[2];
    this.#toolOutcomes.set(toolCallId, observation);
    const pending = this.#pendingToolCalls.get(toolCallId);
    if (pending) {
      this.#pendingToolCalls.set(toolCallId, {
        ...pending,
        ...(observation.outcome ? { outcome: observation.outcome } : {}),
        ...(observation.exitCode !== undefined ? { exitCode: observation.exitCode } : {}),
        ...(observation.failureKind ? { failureKind: observation.failureKind } : {}),
      });
      this.#toolOutcomes.delete(toolCallId);
    }
    await this.recorder.recordToolObservation(...args);
  }

  async recordModelCall(...args: Parameters<SessionRecorder["recordModelCall"]>): Promise<void> {
    await this.recorder.recordModelCall(...args);
  }

  async recordToolCall(...args: Parameters<SessionRecorder["recordToolCall"]>): Promise<void> {
    await this.recorder.recordToolCall(...args);
  }

  async recordCompaction(...args: Parameters<SessionRecorder["recordCompaction"]>): Promise<void> {
    await this.recorder.recordCompaction(...args);
  }

  async completeTurn(...args: Parameters<SessionRecorder["completeTurn"]>): Promise<void> {
    await this.#drain();
    await this.recorder.completeTurn(...args);
    if (this.#activeTurnId === args[0]) {
      this.#activeTurnId = undefined;
    }
  }

  async endSegment(...args: Parameters<SessionRecorder["endSegment"]>): Promise<void> {
    await this.#drain();
    await this.recorder.endSegment(...args);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    let drainError: unknown;
    try {
      await this.#drain();
    } catch (error) {
      drainError = error;
    }
    await this.recorder.close();
    if (drainError !== undefined) throw drainError;
  }
}

export function observeSessionRecorder(
  recorder: SessionRecorder,
  options: SessionObservationRecorderOptions = {},
): SessionRecorder {
  return new ObservedSessionRecorder(recorder, options);
}
