/**
 * Runtime Core Types
 *
 * Types related to the core state container that runs through the entire lifecycle.
 * This is the dependency hub - most other types depend on this.
 */

import type { StreamEventDispatcher } from "../../utils/stream-event-dispatcher";
import type { TeardownRegistry } from "../../utils/teardown";
import type { JsonObjectLoose } from "../../utils/type";
import type { BudgetConfig, BudgetState } from "../domain/budget";
import type { JsonSchema, MessageContent, ModelAdapter } from "../domain/model";
import type { AgentStreamEvent, OnStreamConsumer, OnStreamOptions } from "../domain/stream";
import type { ToolChoice, ToolDefinition } from "../domain/tool";
import type { TraceContext } from "../domain/trace";
import type { AgentFrameSnapshot, JournalEntry } from "./snapshot";
import type { ToolCallLoopMiddleware } from "./tool-call-loop";
import type { ExpectValidatorEntry } from "./validation";

/**
 * Minimal interface for emitting trace events (e.g. inject custom collector in runWith).
 * Implement only this when you only need to receive events (OpenTelemetry, Datadog, console).
 */
export interface TraceEventEmitter<TEvent = any> {
  emit(event: TEvent): void;
}

export type ProviderBinding =
  | {
      value: unknown;
      origin: "seeded";
    }
  | {
      value: unknown;
      origin: "resource";
      owner: string;
    };

export interface ResourceRuntime {
  /** Live owned resource instances, keyed by equipResource key */
  active: Map<string, unknown>;
  /** Internal lifecycle metadata for active resource instances */
  metadata: Map<string, unknown>;
}

/**
 * ScopeLayer for equipScope/expectScope
 *
 * **MUST be JSON-serializable** - only plain values allowed:
 * - ✅ string, number, boolean, null
 * - ✅ plain object (not class instance)
 * - ✅ array of plain values
 * - ❌ function, symbol, undefined
 * - ❌ class instances (Date, Map, Set, RegExp, etc.)
 */
export type ScopeLayer = JsonObjectLoose;

export interface StreamConsumerRegistration {
  consumer: OnStreamConsumer;
  options: OnStreamOptions;
}

export interface StreamConsumerTask {
  promise: Promise<void>;
  awaitOnEnd: boolean;
}

export interface StreamRuntimeState {
  dispatcher: StreamEventDispatcher<AgentStreamEvent>;
  controller: AbortController;
  consumerTasks: StreamConsumerTask[];
  startedConsumerCount: number;
}

/**
 * Agent runtime state (cleared on each reborn)
 */
export type CallId = string;
export type Hash = string;

export interface AgentRunDraft {
  systemPrompts: string[];
  instructions: MessageContent[];
  validators: ExpectValidatorEntry[];
  tools: ToolDefinition[];
  toolCallLoopMiddlewares: ToolCallLoopMiddleware[];
  streamConsumers: StreamConsumerRegistration[];
  streamRuntime?: StreamRuntimeState;
  budgetConfigs: BudgetConfig[];
  /** Scope layers for equipScope (stack-based, key-level replacement) */
  scopeLayers: ScopeLayer[];
  /** Journal for recording calls (reset on reborn) */
  journal: {
    prompt: Record<Hash, JournalEntry>;
    tool: Record<Hash, JournalEntry>;
    agent: Record<CallId, boolean>;
  };
  /** Children Agent frames (reset on reborn, but preserved in snapshot) */
  children: Record<string, AgentFrameSnapshot>;
  /** Per (type:configId) counter for generating strictly increasing seq in callId (decoupled from journal) */
  callCounters: Record<string, number>;
  /** if promptAgent has been used */
  prompted?: boolean;
  /** if executeValidation ran during this generation (used to warn when registered validators were skipped) */
  validationRan?: boolean;
  /** Number of LLM turns executed (incremented on every executeTurn call, reset on reborn) */
  steps: number;
  /** Trace attributes to merge into agent:end trace (set via equipTraceAttr) */
  traceAttributes?: Record<string, unknown>;
}

/**
 * Shared context - chain-wide data shared by all agents in the same runWith tree.
 * Set at runWith (e.g. modelRegistry) and inherited by every agent context.
 */
export interface SharedContext {
  /** Model registry: id -> ModelAdapter. Agents can use model: 'id' to resolve from here. */
  modelRegistry?: Record<string, ModelAdapter>;
}

/**
 * Result of createAgentContext
 *
 * cleanup: run at context exit (e.g. in finally). Includes teardown registry execution,
 * clearing runtime state, and unbinding parent-child signal. Safe to await when used
 * as top-level entry (non-Agent).
 */
export interface CreateContextResult {
  ctx: AgentContext;
  cleanup: () => void | Promise<void>;
}

/**
 * Options for callLLM
 */
export interface CallLLMOptions {
  schema?: JsonSchema;
  signal?: AbortSignal;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  turnIndex?: number;
  /** Stream-event channel tag stamped on every event of this call; see `AgentStreamEventBase.channel`. */
  channel?: string;
  /** Escape hatch for provider-specific stream options, forwarded to model.stream(). */
  additionalOptions?: Record<string, unknown>;
}

/**
 * Agent context - the core state container
 */
export interface AgentContext {
  // ── 1. Identity & Topology ────────────────────────────────────────
  /** Static definition ID of this agent, e.g. "search_agent" */
  agentId: string;
  /** Dynamic call ID for this execution frame, e.g. "root" or "root/agent:setup:0" */
  callId: string;
  /** Depth in the agent call tree (0 = root) */
  depth: number;
  /** Reference to parent context, forming the tree topology */
  parentContext?: AgentContext;

  // ── 2. Control Flow & Lifecycle ───────────────────────────────────
  /** AbortController for cancelling this agent's execution */
  controller: AbortController;
  /** AbortSignal derived from controller, threaded into all async operations */
  signal: AbortSignal;
  /** Teardown registry - manages cleanup functions to execute in finally block */
  teardown: TeardownRegistry;

  // ── 3. State & Storage ────────────────────────────────────────────
  /** Draft: volatile state, cleared on each reborn */
  draft: AgentRunDraft;
  /** Memory: logical state, preserved across reborn, must be serializable (enters snapshot) */
  memory: Map<string, unknown>;
  /** Ephemeral: physical state, preserved across reborn, not required to be serializable */
  ephemeral: Map<string, unknown>;
  /**
   * Snapshot data for replay (optional, set when restoring from snapshot)
   * Contains frame snapshot for current frame and child frames
   */
  snapshot?: AgentFrameSnapshot;
  /** Whether to enable snapshot (default from createAgentContext: IS_DEV) */
  enableSnapshot: boolean;

  // ── 4. DI & Resources ────────────────────────────────────────────
  /** Runtime resource state (non-persistent, stores owned resource instances and metadata) */
  resources?: ResourceRuntime;
  /** Exposed resources map (for expectResource to find parent resources via IoC) */
  providers?: Map<string, ProviderBinding>;

  // ── 5. Shared (chain-wide) ────────────────────────────────────────
  /** Shared by all agents in the chain (e.g. modelRegistry from runWith). Inherited from parent. */
  shared?: SharedContext;

  // ── 6. Configuration & Adapters ───────────────────────────────────
  /** LLM model adapter (inherited from createAgent config or parent) */
  model?: ModelAdapter;
  /** Max retry attempts for LLM calls on transient failures */
  maxRetries: number;
  /** Max LLM turns in the promptAgent loop before abort (not per-tool-call count). */
  maxTurnSteps: number;
  /** Event emitter for this agent (inherited from config or parent; only emit is required) */
  eventBus?: TraceEventEmitter;

  // ── 7. Observability & Telemetry ──────────────────────────────────
  /** OTel-style trace context for this span (traceId, spanId, etc.) */
  trace?: TraceContext;
  /** Parent trace context; trace chain length may differ from context chain, so parent is stored explicitly */
  parentTrace?: TraceContext;
  /** Current generation ID (0-based), set when running inside agent reborn loop */
  generationId?: number;
  /** Budget state for hierarchical token/cost tracking (own + aggregate) */
  budgetState: BudgetState;
}
