/**
 * Event Types
 *
 * Defines all event types for telemetry and debugging.
 */

import type { UsageStats } from "./budget";
import type { ErrorInfo } from "./errors";
import type { DraftViewModel, MiddlewareInfo, TurnToolConfig } from "./event-payload";
import type { FinishReason, JsonSchema, Message, TokenUsage, ToolCall } from "./model";
import type { TraceContext } from "./trace";

// ============ Event Type Constants ============

/**
 * Event type constants
 */
export const EVENTS = {
  AGENT_START: "agent:start",
  AGENT_END: "agent:end",
  AGENT_REBORN: "agent:reborn",
  // Generation events
  GENERATION_START: "generation:start",
  GENERATION_END: "generation:end",
  // PromptAgent events (entire promptAgent call including tool loop)
  PROMPT_AGENT_START: "promptAgent:start",
  PROMPT_AGENT_END: "promptAgent:end",
  // Turn events (step orchestrator)
  TURN_START: "turn:start",
  TURN_END: "turn:end",
  VALIDATION_FAIL: "validation:fail",
  VALIDATION_SUCCESS: "validation:success",
  ERROR: "error",
  /** * System log event.
   * Bridged from the internal Logger. Only emitted when within an active Trace Context.
   */
  SYS_LOG: "sys:log",
  // Model call events
  MODEL_CALL_START: "model:call:start",
  MODEL_CALL_END: "model:call:end",
  // Custom span events
  CUSTOM_SPAN_START: "custom:span:start",
  CUSTOM_SPAN_END: "custom:span:end",
  // Tool execution events
  TOOLS_EXECUTE_START: "tools:execute:start",
  TOOLS_EXECUTE_END: "tools:execute:end",
  // RunWith events
  RUN_WITH_START: "runWith:start",
  RUN_WITH_END: "runWith:end",
  // Budget events
  BUDGET_UPDATE: "budget:update",
  // Resource events (span: start/end for equipResource create/destroy)
  RESOURCE_OP_START: "resource:op:start",
  RESOURCE_OP_END: "resource:op:end",
  // Instrument events (span: start/end for traced calls on an instrumented object)
  INSTRUMENT_OP_START: "instrument:op:start",
  INSTRUMENT_OP_END: "instrument:op:end",
} as const;

/**
 * Wire schema discriminator for trace events (equality-checked, no semver ranges).
 *
 * Increment this when the serialized event contract changes in a way that
 * cross-version consumers (DevTool / Jaeger / OTLP exporters) need to detect.
 */
export const TRACE_EVENT_SCHEMA_VERSION = 1;

/**
 * Event type union
 */
export type EventType = (typeof EVENTS)[keyof typeof EVENTS];

// ============ Base Event Types ============

/**
 * Base trace event (all events extend this).
 * Events that need generation scope declare generationId on the event itself.
 */
export interface BaseTraceEvent {
  /** Trace event wire schema version */
  schemaVersion: typeof TRACE_EVENT_SCHEMA_VERSION;
  /** Event type */
  type: EventType;
  /** Trace context */
  trace: TraceContext;
  /** Event timestamp */
  timestamp: number;
  /** Agent ID (if available) */
  agentId?: string;
}

// ============ Agent Events ============

/**
 * Agent start event
 */
export interface AgentStartEvent extends BaseTraceEvent {
  type: typeof EVENTS.AGENT_START;
  /** Input props */
  props: unknown;
  /** Applied middlewares (name + config) for debug */
  middlewares?: MiddlewareInfo[];
  /** Scope layers snapshot (same shape as DraftViewModel.scopeLayers) */
  scopeLayers: Record<string, unknown>[];
  /** Keys of equipped resources */
  resourceKeys: string[];
  /** Resolved reborn cap for this invocation (config.maxReborns or the default) */
  maxReborns: number;
}

/**
 * Agent end event
 *
 * Contains all start event info for Jaeger span generation.
 */
export interface AgentEndEvent extends Omit<AgentStartEvent, "type"> {
  type: typeof EVENTS.AGENT_END;
  /** Result (if success) */
  result?: unknown;
  /** Duration in ms */
  duration: number;
  /** Whether completed successfully */
  success: boolean;
  /** Number of generations run */
  generationCount: number;
  /** Error info (if failed) */
  error?: ErrorInfo;
}

/**
 * Agent reborn event
 */
export interface AgentRebornEvent extends BaseTraceEvent {
  type: typeof EVENTS.AGENT_REBORN;
  /** Generation ID (0-based: 0, 1, 2...) */
  generationId: number;
  /** New props (if changed) */
  newProps?: unknown;
}

// ============ Generation Events ============

/**
 * Generation start event
 *
 * Emitted when a new generation starts (first execution or after reborn).
 * No draft/memory here: draft is still empty and memory unchanged at start.
 */
export interface GenerationStartEvent extends BaseTraceEvent {
  type: typeof EVENTS.GENERATION_START;
  /** Generation ID (0-based: 0, 1, 2...) */
  generationId: number;
  /** Props for this generation */
  props: unknown;
}

/**
 * Generation end reason.
 */
export type GenerationEndReason = "return" | "error" | "reborn";

/**
 * Generation end event
 *
 * Emitted when a generation ends (before reborn or on final completion).
 * Exposes only draft (Prompt assembly) and memory (this round's changes) for DevTool.
 */
export interface GenerationEndEvent extends Omit<GenerationStartEvent, "type"> {
  type: typeof EVENTS.GENERATION_END;
  /** Single termination reason */
  endReason: GenerationEndReason;
  /** Result when endReason === 'return' */
  result?: unknown;
  /** Duration in ms */
  duration: number;
  /** Whether completed successfully */
  success: boolean;
  /** Error info when endReason === 'error' */
  error?: ErrorInfo;
  /** Assembled prompt view for DevTool (no journal/children/callCounters) */
  draft: DraftViewModel;
  /** Memory state after this generation */
  memory: Record<string, unknown>;
}

// ============ PromptAgent Events ============

/**
 * PromptAgent start event
 *
 * Emitted when promptAgent() is called (before any LLM calls)
 */
export interface PromptAgentStartEvent extends BaseTraceEvent {
  type: typeof EVENTS.PROMPT_AGENT_START;
  /** Generation ID (0-based: 0, 1, 2...) */
  generationId: number;
  /** JSON Schema (if used) */
  schema?: JsonSchema;
  /** Selected policy ID (e.g. "standard-structure") */
  policyId: string;
  // Policy-derived metadata (written via the policy `span` handle) lives on the canonical
  // bag `trace.attributes` (TraceContext): the end-event snapshot carries what the policy
  // accumulated during execution. See createAgentPolicy.
}

/**
 * PromptAgent end event
 *
 * Emitted when promptAgent() completes (after all tool loops)
 * Contains all start event info for Jaeger span generation.
 */
export interface PromptAgentEndEvent extends Omit<PromptAgentStartEvent, "type"> {
  type: typeof EVENTS.PROMPT_AGENT_END;
  /** Final result data (if success) */
  result?: unknown;
  /** Total number of turns/steps */
  totalSteps: number;
  /** Duration in ms */
  duration: number;
  /** Whether completed successfully */
  success: boolean;
  /** Error info (if failed) */
  error?: ErrorInfo;
  /** Whether result was from cache */
  cache?: boolean;
}

// ============ Turn Events ============

/**
 * Turn start event
 */
export interface TurnStartEvent extends BaseTraceEvent {
  type: typeof EVENTS.TURN_START;
  /** Turn/step number (0-based) */
  step: number;
  /** Complete conversation context for this logical turn. */
  messages: Message[];
  /** Target structured-output schema for this logical turn. */
  schema?: JsonSchema;
  /** Tool configuration selected by policy for this logical turn. */
  toolConfig?: TurnToolConfig;
  /** Number of messages */
  messageCount: number;
}

/**
 * Turn end event
 *
 * Contains all start event info for Jaeger span generation.
 */
export interface TurnEndEvent extends Omit<TurnStartEvent, "type"> {
  type: typeof EVENTS.TURN_END;
  /** Result type: 'content' (final) or 'tool_calls' (continue) */
  resultType: "content" | "tool_calls";
  /** Final assistant message for this logical turn. */
  message?: Message;
  /** Duration in ms */
  duration: number;
  /** Whether completed successfully */
  success: boolean;
  /** Error info (if failed) */
  error?: ErrorInfo;
  /** Prompt journal content hash for this LLM turn. */
  contentHash?: string;
  /** Whether this turn was satisfied from snapshot journal replay (no live LLM) */
  cache?: boolean;
}

/**
 * Validation failure event
 */
export interface ValidationFailEvent extends BaseTraceEvent {
  type: typeof EVENTS.VALIDATION_FAIL;
  // === Input ===
  /** Raw text that failed validation */
  rawText: string;
  /** Parser identifier; "rawText" when no parser is used */
  parserId: string;
  /** Retry attempt number, when validation happens inside a retry loop */
  attempt?: number;
  // === Output ===
  /** Partial/failed data (if parse succeeded but validation failed) */
  data?: unknown;
  // === Status ===
  /** Always false for fail event */
  success: false;
  /** Validation errors */
  errors: ErrorInfo[];
}

/**
 * Validation success event
 */
export interface ValidationSuccessEvent extends BaseTraceEvent {
  type: typeof EVENTS.VALIDATION_SUCCESS;
  // === Input ===
  /** Raw text that was validated */
  rawText: string;
  /** Parser identifier; "rawText" when no parser is used */
  parserId: string;
  /** Retry attempt number, when validation happens inside a retry loop */
  attempt?: number;
  // === Output ===
  /** Successfully validated data */
  data: unknown;
  // === Status ===
  /** Always true for success event */
  success: true;
}

// ============ Error Events ============

/**
 * Error event
 */
export interface ErrorEvent extends BaseTraceEvent {
  type: typeof EVENTS.ERROR;
  /** Error info */
  error: ErrorInfo;
}

/**
 * System log event
 *
 * Emitted by the internal logger. Guaranteed to have a trace context
 * (logs outside a trace context are degraded to console.warn).
 */
export interface SysLogEvent extends BaseTraceEvent {
  type: typeof EVENTS.SYS_LOG;
  /** Log level */
  level: "debug" | "info" | "warning" | "error";
  /** Log message */
  message: string;
  /** Log arguments (serializable for telemetry) */
  args: unknown[];
}

// ============ Model Call Events ============

/**
 * Model call start event
 */
export interface ModelCallStartEvent extends BaseTraceEvent {
  type: typeof EVENTS.MODEL_CALL_START;
  /** Adapter ID */
  adapterId: string;
  /** Provider name (optional) */
  provider?: string;
  /** Number of messages */
  messageCount: number;
  /** Whether tools are provided */
  usedTools: boolean;
  /** Applied middlewares (name + config) for debug */
  middlewares?: MiddlewareInfo[];
  /** Physical network retry index (0 = first request). */
  networkAttempt?: number;
}

/**
 * Model call end event
 *
 * Contains all start event info for Jaeger span generation.
 */
export interface ModelCallEndEvent extends Omit<ModelCallStartEvent, "type"> {
  type: typeof EVENTS.MODEL_CALL_END;
  /** Raw text returned by this physical request. */
  rawText: string;
  /** Reasoning returned by this physical request. */
  reasoning?: string;
  /** Tool calls parsed from this physical request. */
  toolCalls?: ToolCall[];
  /** Duration in ms */
  duration: number;
  /** Time to first token in ms (from request start to first token received) */
  ttft?: number;
  /** Token usage (if success); reasoning models include details.reasoningTokens */
  usage?: TokenUsage;
  /** Computed costs by billing unit (if success), integers only */
  costs?: Record<string, number>;
  /** Why the model stopped (e.g. stop, length, tool_calls) */
  finishReason?: FinishReason;
  /** Whether completed successfully */
  success: boolean;
  /** Error info (if failed) */
  error?: ErrorInfo;
}

// ============ Custom Span Events ============

/**
 * Custom span start event
 */
export interface CustomSpanStartEvent extends BaseTraceEvent {
  type: typeof EVENTS.CUSTOM_SPAN_START;
  /** Span name */
  name: string;
  // Span attributes live on the canonical bag `trace.attributes` (TraceContext),
  // seeded with the static attributes known at start. See withCustomSpan.
}

/**
 * Custom span end event
 */
export interface CustomSpanEndEvent extends Omit<CustomSpanStartEvent, "type"> {
  type: typeof EVENTS.CUSTOM_SPAN_END;
  // `trace.attributes` on the end event carries the final merged bag: static
  // attributes plus any added during execution via span.setAttribute().
  /** Duration in ms */
  duration: number;
  /** Whether completed successfully */
  success: boolean;
  /** Error info (if failed) */
  error?: ErrorInfo;
}

// ============ Tool Execution Events ============

/**
 * Individual tool execution result
 */
export interface ToolExecutionResult {
  /** Tool call ID */
  callId: string;
  /** Tool name */
  toolName: string;
  /** Input arguments (parsed and validated) */
  input: unknown;
  /**
   * Output result (parsed if JSON, otherwise string). Single source of truth for
   * the tool output: consumers that need a string view derive it on read (e.g.
   * devtool's renderToolOutput). The former denormalized `rawOutput` mirror was
   * removed to avoid doubling the payload over the wire.
   */
  output: unknown;
  /** Duration in ms for this tool */
  duration: number;
  /** Whether execution succeeded */
  success: boolean;
  /** Error info (if failed) */
  error?: ErrorInfo;
  /** Whether result was from cache */
  cache?: boolean;
  /** Content hash for cache identification */
  contentHash?: string;
}

/**
 * Tools execute start event
 */
export interface ToolsExecuteStartEvent extends BaseTraceEvent {
  type: typeof EVENTS.TOOLS_EXECUTE_START;
  /** Number of tool calls */
  toolCallsCount: number;
  /** Tool names being executed */
  toolNames: string[];
  /** Middlewares in execution order (built-in cache omitted) for debug */
  toolMiddlewares?: MiddlewareInfo[];
}

/**
 * Tools execute end event
 *
 * Contains all start event info for Jaeger span generation.
 */
export interface ToolsExecuteEndEvent extends Omit<ToolsExecuteStartEvent, "type"> {
  type: typeof EVENTS.TOOLS_EXECUTE_END;
  /** Number of successful tool executions */
  successCount: number;
  /** Number of failed tool executions */
  failureCount: number;
  /** Duration in ms */
  duration: number;
  /** Individual tool execution results */
  toolResults: ToolExecutionResult[];
  /** Whether all tools executed successfully */
  success: boolean;
  /** Error info (if any tool failed) */
  error?: ErrorInfo;
}

// ============ Budget Events ============

/**
 * Budget update event
 *
 * Emitted once at the start of updateBudgetChain (when recording LLM or tool usage).
 */
export interface BudgetUpdateEvent extends BaseTraceEvent {
  type: typeof EVENTS.BUDGET_UPDATE;
  /** Identifiers for updated items (one per item in delta.items), for batch updates */
  identifiers: string[];
  /** Incremental usage delta being applied */
  delta: UsageStats;
  /** Aggregate usage of the initiating context (after this delta is applied) */
  aggregate: UsageStats;
  /** Own usage of the initiating context (self only, after this delta is applied) */
  own: UsageStats;
}

// ============ Resource Events ============

/** Resource operation kind for span events */
export type ResourceOperation = "create" | "destroy";

/**
 * Resource operation start event
 *
 * Emitted when a resource create or destroy starts (equipResource).
 * Pairs with RESOURCE_OP_END for span duration and OTLP export.
 */
export interface ResourceOpStartEvent extends BaseTraceEvent {
  type: typeof EVENTS.RESOURCE_OP_START;
  /** Operation kind */
  operation: ResourceOperation;
  /** Resource identifier (equipResource key) */
  resourceId: string;
  /**
   * create: current deps that triggered this create.
   * destroy: old deps that were used when the resource being destroyed was created (not the new deps that triggered the destroy).
   */
  deps?: unknown[];
}

/**
 * Resource operation end event
 *
 * Emitted when a resource create or destroy completes.
 * When operation is "create" and reused is true, the active resource instance was reused.
 */
export interface ResourceOpEndEvent extends Omit<ResourceOpStartEvent, "type"> {
  type: typeof EVENTS.RESOURCE_OP_END;
  /** Duration in ms */
  duration: number;
  /** Whether the operation succeeded */
  success: boolean;
  /** Error info (if failed) */
  error?: ErrorInfo;
  /** When operation is "create" and true, an existing active resource instance was reused. */
  reused?: boolean;
}

// ============ Instrument Events ============

/**
 * Instrument operation start event
 *
 * Emitted when a traced method call on an instrumented object (see `instrument()`) starts.
 * Type-agnostic: the wrapped target may be any injected dependency (storage client,
 * payment SDK, vector DB, ...). Pairs with INSTRUMENT_OP_END for span duration and OTLP export.
 */
export interface InstrumentOpStartEvent extends BaseTraceEvent {
  type: typeof EVENTS.INSTRUMENT_OP_START;
  /** Instrument category name (e.g. 'redis', 'stripe') */
  name: string;
  /** Operation = the invoked method name */
  operation: string;
  // Redacted derive metadata (from derive.call/result/error) lives on the canonical
  // bag `trace.attributes` (TraceContext): start carries the call-time subset, end the
  // merged final set. Never raw arguments/results/errors by default (PII / payload-size
  // guard). See instrument().
}

/**
 * Instrument operation end event
 *
 * Emitted when a traced call on an instrumented object completes.
 * Carries duration, success, optional error info, and derived metadata.
 */
export interface InstrumentOpEndEvent extends Omit<InstrumentOpStartEvent, "type"> {
  type: typeof EVENTS.INSTRUMENT_OP_END;
  /** Duration in ms */
  duration: number;
  /** Whether the operation succeeded */
  success: boolean;
  /** Error info (if failed) */
  error?: ErrorInfo;
}

// ============ RunWith Events ============

/**
 * RunWith start event
 *
 * Emitted when runWith() starts executing.
 * Root span for the Agent execution tree; records global context and config.
 */
export interface RunWithStartEvent extends BaseTraceEvent {
  type: typeof EVENTS.RUN_WITH_START;
  /** Business input */
  props: unknown;
  /** Run environment and safety config */
  config: {
    /** Whether running in production (IS_PROD) */
    isProd: boolean;
    /** Whether snapshot recording/write is enabled (key for cache penetration) */
    enableSnapshot: boolean;
  };
  /** Injected dependencies state */
  dependencies: {
    hasEventBus: boolean;
    /** Whether root fallback model is configured */
    hasGlobalModel: boolean;
    /** modelRegistry keys (for DevTool to see which models are available) */
    registeredModels: string[];
    /** Root-seeded provider keys (for DevTool to see which providers are injected) */
    registeredProviders?: string[];
  };
  /**
   * Time-travel provenance. Present only when both snapshot was provided and
   * enableSnapshot is true (i.e. a real restore-with-provenance run).
   * Undefined otherwise (normal run, or snapshot injected but enableSnapshot off).
   */
  restoration?: {
    /** Identifies this as a restored run */
    isRestored: true;
    /** Process ID of the run that produced the snapshot */
    sourceProcessId: string;
    /** When the snapshot was created (ms) */
    snapshotTimestamp: number;
    /** Snapshot data structure version */
    snapshotVersion: number;
    /** Provenance of the snapshot for trace linkage */
    provenance: {
      traceId: string;
      spanId?: string;
      anchor?: "before" | "after";
      source?: "dump" | "restore";
    };
    // Snapshot-level business tags (passthrough) live on the canonical bag
    // `trace.attributes` (TraceContext), namespaced under `restoration.*` to mark them as
    // provenance from the foreign run that produced the snapshot. See runWith() / dumpSnapshot.
  };
}

/**
 * RunWith end event
 *
 * Emitted when runWith() completes.
 * Contains all start event info for Jaeger span generation.
 * Carries global metrics and runtime flags for billing/debugging.
 */
export interface RunWithEndEvent extends Omit<RunWithStartEvent, "type"> {
  type: typeof EVENTS.RUN_WITH_END;
  /** Result (if success) */
  result?: unknown;
  /** Duration in ms */
  duration: number;
  /** Whether completed successfully */
  success: boolean;
  /** Error info (if failed) */
  error?: ErrorInfo;
  /** Global metrics from rootCtx.budgetState.aggregate */
  metrics: {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    /** Aggregated financial amounts by billing unit when available */
    costs?: Record<string, number>;
  };
}

// ============ Event Map & Union Types ============

/**
 * Maps each known event type constant to its event payload interface.
 * Enables type-safe subscribe(type, (event) => ...) with inferred event type.
 */
export interface TraceEventMap {
  [EVENTS.AGENT_START]: AgentStartEvent;
  [EVENTS.AGENT_END]: AgentEndEvent;
  [EVENTS.AGENT_REBORN]: AgentRebornEvent;
  [EVENTS.GENERATION_START]: GenerationStartEvent;
  [EVENTS.GENERATION_END]: GenerationEndEvent;
  [EVENTS.PROMPT_AGENT_START]: PromptAgentStartEvent;
  [EVENTS.PROMPT_AGENT_END]: PromptAgentEndEvent;
  [EVENTS.TURN_START]: TurnStartEvent;
  [EVENTS.TURN_END]: TurnEndEvent;
  [EVENTS.VALIDATION_FAIL]: ValidationFailEvent;
  [EVENTS.VALIDATION_SUCCESS]: ValidationSuccessEvent;
  [EVENTS.ERROR]: ErrorEvent;
  [EVENTS.SYS_LOG]: SysLogEvent;
  [EVENTS.MODEL_CALL_START]: ModelCallStartEvent;
  [EVENTS.MODEL_CALL_END]: ModelCallEndEvent;
  [EVENTS.CUSTOM_SPAN_START]: CustomSpanStartEvent;
  [EVENTS.CUSTOM_SPAN_END]: CustomSpanEndEvent;
  [EVENTS.TOOLS_EXECUTE_START]: ToolsExecuteStartEvent;
  [EVENTS.TOOLS_EXECUTE_END]: ToolsExecuteEndEvent;
  [EVENTS.RUN_WITH_START]: RunWithStartEvent;
  [EVENTS.RUN_WITH_END]: RunWithEndEvent;
  [EVENTS.BUDGET_UPDATE]: BudgetUpdateEvent;
  [EVENTS.RESOURCE_OP_START]: ResourceOpStartEvent;
  [EVENTS.RESOURCE_OP_END]: ResourceOpEndEvent;
  [EVENTS.INSTRUMENT_OP_START]: InstrumentOpStartEvent;
  [EVENTS.INSTRUMENT_OP_END]: InstrumentOpEndEvent;
}

/**
 * Catch-all event type for future extension and third-party events.
 * Uses `EventType | (string & {})` so that switch(event.type) is never exhaustive without a default branch,
 * while preserving IDE autocomplete for known event types and type-checking against typos.
 */
/** Extension events: base fields from BaseTraceEvent, type as string; extra props at runtime */
export type UnknownExtensionEvent = Omit<BaseTraceEvent, "type"> & {
  type: string & {};
  [key: string]: unknown;
};

/**
 * All trace events union (derived from TraceEventMap + extension)
 */
export type TraceEvent = TraceEventMap[keyof TraceEventMap] | UnknownExtensionEvent;
