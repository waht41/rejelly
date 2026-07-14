/**
 * Testing module type definitions
 */

import type { EventType, TraceEvent } from "../core/domain/events";
import type { JsonSchema, Message, ModelAdapter, TokenUsage } from "../core/domain/model";
import type { ToolDefinition } from "../core/domain/tool";
import type { EventBus } from "../core/observability/event-bus";
import type { JsonValue } from "../utils/type";

// ---------- mock-model ----------

/**
 * Call record - each LLM call generates one record
 */
export interface CallRecord {
  /** Messages sent to model */
  messages: Message[];
  /** JSON Schema (if any) */
  schema?: JsonSchema;
  /** Timestamp */
  timestamp: number;
  /** Call index (0-based) */
  index: number;
}

/**
 * Rule payload (passed to condition function)
 */
export interface RulePayload {
  messages: Message[];
  schema?: JsonSchema;
  lastUserMessage?: string;
  userMessages: string[];
}

/**
 * Rule condition types
 */
export type RuleCondition =
  | { input: string | RegExp }
  | { toolName: string }
  | ((payload: RulePayload) => boolean);

/**
 * Mock response type
 */
export type MockResponse = string | JsonValue;

/** Stream chunk type - string only to avoid array/object confusion */
export type StreamChunk = string;

/**
 * Mock usage config
 */
export interface MockUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Extra token dimensions forwarded to TokenUsage.details (e.g. reasoningTokens, cacheReadTokens) */
  details?: Record<string, number>;
}

/**
 * Mock tool call config
 */
export interface MockToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Tool-call-level metadata (forwarded to StreamEvent.tool_call.toolCall.extra). */
  extra?: Record<string, unknown>;
}

/** Stream input: array of string chunks, or object to stringify and split by chunkSize */
export type StreamInput = string[] | JsonValue;

/**
 * Rule configuration (internal)
 */
export interface RuleConfig {
  condition: RuleCondition;
  responseType: "return" | "stream" | "throw" | "tool_call" | "custom";
  response?: MockResponse;
  chunks?: StreamChunk[];
  /** When set, stringify and split by streamChunkSize instead of using chunks */
  streamObject?: JsonValue;
  streamChunkSize?: number;
  error?: Error;
  delay?: number;
  chunkInterval?: number;
  /** Message-level metadata emitted as StreamEvent { type: "extra" }. */
  extra?: Record<string, unknown>;
  usage?: MockUsage;
  toolCalls?: MockToolCall[];
  customFn?: (payload: RulePayload) => Promise<MockResponse>;
}

/**
 * Rule builder interface
 */
export interface RuleBuilder {
  thenReturn(response: MockResponse): RuleBuilder;
  thenStream(chunksOrObject: StreamInput, chunkSize?: number): RuleBuilder;
  thenCallTools(toolCalls: MockToolCall[]): RuleBuilder;
  thenThrow(error: Error): RuleBuilder;
  thenDo(fn: (payload: RulePayload) => Promise<MockResponse>): RuleBuilder;
  withDelay(ms: number): RuleBuilder;
  withChunkInterval(ms: number): RuleBuilder;
  withExtra(extra: Record<string, unknown>): RuleBuilder;
  withUsage(usage: MockUsage): RuleBuilder;
}

interface MockSequenceStepBase {
  delay?: number;
  chunkInterval?: number;
  extra?: Record<string, unknown>;
  usage?: MockUsage;
}

/**
 * Discriminated union for sequence() steps.
 * Use object literals for strict IDE completion and validation.
 */
export type MockSequenceStep =
  | (MockSequenceStepBase & { type: "text"; content: string })
  | (MockSequenceStepBase & { type: "json"; content: JsonValue })
  | (MockSequenceStepBase & { type: "stream"; chunks: StreamChunk[] })
  | (MockSequenceStepBase & { type: "stream_object"; content: JsonValue; chunkSize?: number })
  | (MockSequenceStepBase & { type: "tool_calls"; calls: MockToolCall[] })
  | (MockSequenceStepBase & { type: "error"; error: Error })
  | (MockSequenceStepBase & {
      type: "custom";
      handler: (payload: RulePayload) => Promise<MockResponse>;
    });

/**
 * Calls API for inspecting mock calls
 */
export interface CallsAPI {
  all(): CallRecord[];
  count(): number;
  first(): CallRecord | undefined;
  last(): CallRecord | undefined;
  clear(): void;
}

/**
 * Mock model interface
 */
export interface MockModel {
  when(condition: RuleCondition): RuleBuilder;
  calls: CallsAPI;
  adapter: ModelAdapter;
  reset(): void;
  setDefaultResponse(response: MockResponse): void;
  setDefaultUsage(usage: MockUsage): void;
  sequence(steps: MockSequenceStep[]): void;
  setSequenceUsage(usage: MockUsage[]): void;
  setSequenceDelay(ms: number): void;
  setDefaultDelay(ms: number): void;
  setCostCalculator(calculator: (usage: TokenUsage) => Record<string, number>): void;
}

// ---------- helpers (TestAgentConfig) ----------

/**
 * Test agent configuration (parameterizes test agent behavior)
 */
export interface TestAgentConfig<TProps = any, TResult = any> {
  id?: string;
  model?: ModelAdapter;
  memory?: Record<string, any>;
  systemPrompt?: string;
  behavior?: "simple" | "echo" | ((props: TProps) => Promise<TResult>);
  children?: Record<string, any>;
  beforePrompt?: () => void | Promise<void>;
}

// ---------- snapshot-utils ----------

/**
 * Normalized snapshot (with unstable fields replaced)
 */
export interface NormalizedSnapshot {
  processId: string;
  timestamp: number;
  root: any;
}

/**
 * Options for expectStateSnapshot
 */
export interface SnapshotOptions {
  testName?: string;
  normalizeFields?: string[];
}

// ---------- scenario ----------

/**
 * Scenario builder interface
 */
export interface ScenarioBuilder {
  withInput(props: any): ScenarioBuilder;
  nextTurn(response: MockResponse): ScenarioBuilder;
  nextTurnWithTools(toolCalls: MockToolCall[]): ScenarioBuilder;
  expectToolCall(toolName: string, args?: any): ScenarioBuilder;
  expectSystemContains(expected: string | RegExp): ScenarioBuilder;
  expectInstructionContains(expected: string | RegExp): ScenarioBuilder;
  expectReturns(expected: any): ScenarioBuilder;
  run(): Promise<any>;
}

/**
 * Internal prompt assertion
 */
export interface PromptAssertion {
  type: "system" | "instruction";
  expected: string | RegExp;
}

/**
 * Internal scenario state
 */
export interface ScenarioState {
  mock: MockModel;
  inputs: any;
  responses: MockSequenceStep[];
  toolCalls: MockToolCall[][];
  expectations: Array<{ toolName: string; args?: any }>;
  promptAssertions: PromptAssertion[];
  expectedReturn?: { value: any };
}

// ---------- trace-utils ----------

/**
 * Agent execution trace
 */
export interface AgentTrace {
  result: any;
  events: TraceEvent[];
  finalMemory: Record<string, any>;
  rebornCount: number;
  filterByType(type: EventType | string): TraceEvent[];
}

/**
 * Options for runAndCaptureEvent
 */
export interface CaptureEventOptions {
  mockModel?: any;
  inputs?: any;
  filter?: (EventType | "*")[];
  eventBus?: EventBus;
}

// ---------- spy-tool ----------

/**
 * Standalone spy function interface (framework-agnostic)
 */
export interface StandaloneSpy<TArgs extends any[] = any[], TReturn = any> {
  (...args: TArgs): TReturn;
  calls: TArgs[];
  readonly callCount: number;
  reset: () => void;
}

/**
 * Spy tool result
 */
export interface SpyToolResult {
  tool: ToolDefinition;
  spy: StandaloneSpy;
}
