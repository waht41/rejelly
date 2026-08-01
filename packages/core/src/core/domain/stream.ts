/**
 * Agent stream types for onStream-style consumers.
 *
 * These types sit above raw ModelAdapter StreamEvent:
 * - include Agent/policy loop context such as turnIndex
 * - distinguish text output vs tool-call argument streaming
 */

import type { FinishReason, TokenUsage, ToolCall, ToolCallChunk } from "./model";

/**
 * Base fields shared by all agent stream events.
 */
export interface AgentStreamEventBase {
  /** Zero-based turn index within the current prompt policy loop. */
  turnIndex: number;
  /**
   * Origin channel of the emitting turn. Undefined = the main conversation stream. Internal
   * side-turns (e.g. a context-compaction summarization call) set a named channel via
   * `ExecuteTurnOptions.channel` so user-facing consumers can skip rendering their output
   * instead of presenting it as the agent's reply.
   */
  channel?: string;
}

export interface AgentTurnStartStreamEvent extends AgentStreamEventBase {
  type: "turn_start";
}

export interface AgentTextStreamEvent extends AgentStreamEventBase {
  type: "text";
  /** Incremental text delta emitted by the model. */
  delta: string;
}

export interface AgentReasoningStreamEvent extends AgentStreamEventBase {
  type: "reasoning";
  /** Incremental reasoning delta emitted by the model. */
  delta: string;
}

export interface AgentStructuredDataStreamEvent extends AgentStreamEventBase {
  type: "structured_data";
  /**
   * `partial`: intermediate parse result while the stream is still open
   * `complete`: final successful parse result at stream end
   * `error`: final parse result at stream end but invalid / incomplete
   */
  status: "partial" | "complete" | "error";
  /**
   * Structured data parsed from the current text buffer.
   *
   * This is a FULL snapshot of the object parsed so far on every event, NOT an
   * incremental delta. A field's value is not guaranteed to grow monotonically
   * between events, re-parsing the accumulated buffer can
   * cause a value to change rather than simply extend (e.g. quote-closing or escape
   * resolution). Consumers that need an increment (e.g. a typewriter effect) must
   * derive it by diffing successive snapshots, and must not assume append-only growth.
   *
   * When `status` is `error`, `data` holds the best-effort partial parse, which may
   * be empty or structurally incomplete.
   *
   * There is deliberately no `delta` field: a snapshot is the only representation
   * that stays correct under re-parsing — an append-delta can't express mutation,
   * and a JSON-patch delta is heavier than this use case needs.
   */
  data: Partial<unknown>;
  /** Whether the current result satisfies partial schema validation. */
  isValid: boolean;
}

export interface AgentToolCallStreamEvent extends AgentStreamEventBase {
  type: "tool_call_stream";
  /** Raw tool-call chunk from the adapter stream. */
  chunk: ToolCallChunk;
}

export interface AgentToolCallReadyEvent extends AgentStreamEventBase {
  type: "tool_call";
  /**
   * Fully assembled tool call after chunk merge.
   *
   * Emitted once the model stream has closed and the buffered chunks can be merged. It arrives
   * before this turn's {@link AgentTurnDoneStreamEvent} and before the tools run.
   */
  toolCall: ToolCall;
}

export interface AgentTurnDoneStreamEvent extends AgentStreamEventBase {
  type: "turn_done";
  /**
   * Why the model stopped, taken from the adapter's `finish` event. This is `"unknown"` when
   * the adapter completes successfully without providing a `finish` event.
   *
   * This is the turn's final stream event. The adapter stream has been fully drained, the final
   * `structured_data` snapshot (when applicable) and assembled `tool_call` events have already
   * been emitted, and usage has been recorded. Tools have not started executing yet.
   */
  finishReason: FinishReason;
}

export interface AgentUsageStreamEvent extends AgentStreamEventBase {
  type: "usage";
  usage: TokenUsage;
}

export interface AgentExtraStreamEvent extends AgentStreamEventBase {
  type: "extra";
  /**
   * Message-level adapter/provider metadata.
   *
   * Current implementation forwards each ModelAdapter `extra` event as it is
   * received. Multiple events may be emitted in one turn; callLLM shallow-merges
   * them into the final assistant message with last-write-wins semantics.
   */
  extra: Record<string, unknown>;
}

export interface AgentErrorStreamEvent extends AgentStreamEventBase {
  type: "error";
  error: unknown;
}

/**
 * Agent-level stream event union exposed to onStream consumers.
 */
export type AgentStreamEvent =
  | AgentTurnStartStreamEvent
  | AgentTextStreamEvent
  | AgentReasoningStreamEvent
  | AgentStructuredDataStreamEvent
  | AgentToolCallStreamEvent
  | AgentToolCallReadyEvent
  | AgentTurnDoneStreamEvent
  | AgentUsageStreamEvent
  | AgentExtraStreamEvent
  | AgentErrorStreamEvent;

/**
 * Async stream consumed by onStream subscribers.
 *
 * There is deliberately no Generation-level "stream ended" event: the generator completing is
 * that signal. Per-turn boundaries are represented by {@link AgentTurnDoneStreamEvent}.
 */
export type AgentStream = AsyncGenerator<AgentStreamEvent, void, void>;

/**
 * Consumer function registered by onStream.
 *
 * The consumer should drain the generator with `for await...of`.
 * Runtime will isolate consumer failures from the producer side.
 *
 * The loop exits normally when the Generation closes the stream and when either the Generation's
 * signal or the consumer's own `signal` cancels the subscription. Producer failures are delivered
 * as {@link AgentErrorStreamEvent} before the Generation shuts down; they do not make this
 * generator throw. A consumer can still throw from its own code, so cleanup that must run on every
 * path belongs in a `finally` around the loop.
 */
export type OnStreamConsumer = (stream: AgentStream) => void | Promise<void>;

export interface OnStreamOptions {
  /** Optional external signal for user-controlled cancellation. */
  signal?: AbortSignal;
  /** Whether generation end should wait for this consumer to finish. Default: true. */
  awaitOnEnd?: boolean;
}
