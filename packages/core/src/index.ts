/**
 * Rejelly - Code-First AI Agent Framework
 *
 * @packageDocumentation
 */

// ============ 1. Defines (Agent Definition) ============

export type {
  EquipToolOptions,
  ToolCallLoopContext,
  ToolCallLoopMiddleware,
  ToolOutput,
  ToolTurn,
  ToolTurnEntry,
} from "./core/context/tool-call-loop";
export type {
  ContentPart,
  FinishReason,
  ImageContent,
  JsonSchema,
  Message,
  MessageContent,
  MessageRole,
  ModelAdapter,
  ModelMiddleware,
  ModelStreamOptions,
  StreamEvent,
  TokenUsage,
  ToolCall,
  ToolCallChunk,
  VideoContent,
} from "./core/domain/model";
export { createAgent } from "./core/engine/agent";
export {
  augmentAgent,
  augmentModel,
  augmentTool,
} from "./core/facade/augment";

// ============ 2. Logic DSL (Writing Logic) ============

export type {
  BudgetConfig,
  BudgetRecord,
  BudgetState,
  BudgetUpdateArg,
  ModelUsageItem,
  RecordToolUsageInput,
  ToolUsageItem,
  UsageItem,
  UsageStats,
} from "./core/domain/budget";
export { recordToolUsage } from "./core/engine/budget-system";
export { isRebornSignal, reborn } from "./core/engine/flow/reborn";
export {
  type InstrumentBaseContext,
  type InstrumentDeriveOptions,
  type InstrumentErrorContext,
  type InstrumentOptions,
  type InstrumentSuccessContext,
  instrument,
} from "./core/engine/instrument";
export { equipBudget } from "./core/facade/equip/budget";
export {
  equipInstruction,
  equipScope,
  equipSystem,
  equipTool,
  equipToolCallLoopMiddleware,
  equipTraceAttr,
} from "./core/facade/equip/equip";
export { equipMemo, equipMemory } from "./core/facade/equip/memory";
export { equipResource } from "./core/facade/equip/resource";
export { expectValidator } from "./core/facade/expect/expect";
export { expectResource } from "./core/facade/expect/resource";
export { expectScope } from "./core/facade/expect/scope";

// ============ 3. Execution (Running & Interaction) ============

export type {
  AgentErrorStreamEvent,
  AgentExtraStreamEvent,
  AgentReasoningStreamEvent,
  AgentStream,
  AgentStreamEvent,
  AgentStreamEventBase,
  AgentStructuredDataStreamEvent,
  AgentTextStreamEvent,
  AgentToolCallReadyEvent,
  AgentToolCallStreamEvent,
  AgentTurnDoneStreamEvent,
  AgentTurnStartStreamEvent,
  AgentUsageStreamEvent,
  OnStreamConsumer,
  OnStreamOptions,
} from "./core/domain/stream";
export { callTool } from "./core/engine/tool-executor";
export { onStream } from "./core/facade/effect";

// ============ 4. Utilities (Helper Functions) ============

export type {
  AttemptsExhaustedPayload,
  BudgetExceededPayload,
  InvalidCostReason,
  InvalidCostValuePayload,
  InvalidPromptRuntimeReason,
  LoopMissingToolOutputPayload,
  ModelCallPayload,
  ModelErrorCode,
} from "./core/domain/errors";
export {
  AbortError,
  AfterPromptAgentError,
  AttemptsExhaustedError,
  BudgetExceededError,
  ContextNotFoundError,
  DuplicateToolNameError,
  ExpectScopeError,
  InvalidCostValueError,
  InvalidMessageHistoryError,
  InvalidPromptRuntimeError,
  InvalidToolOutputError,
  isAbortError,
  isAfterPromptAgentError,
  isAttemptsExhaustedError,
  isBudgetExceededError,
  isContextNotFoundError,
  isDuplicateToolNameError,
  isInvalidCostValueError,
  isInvalidMessageHistoryError,
  isInvalidPromptRuntimeError,
  isInvalidToolOutputError,
  isLoopMissingToolOutputError,
  isMaxDepthExceededError,
  isModelCallError,
  isModelNotFoundError,
  isNotSupportedError,
  isPromptAgentAlreadyCalledError,
  isRebornLimitExceededError,
  isRequiresAgentContextError,
  isResourceNotFoundError,
  isRestoreError,
  isSchemaConversionError,
  isScopeError,
  isSnapshotDisabledError,
  isToolLoopExceededError,
  isTurnBudgetExceededError,
  LoopMissingToolOutputError,
  MaxDepthExceededError,
  ModelCallError,
  ModelNotFoundError,
  ModelRegistryNotFoundError,
  NotSupportedError,
  PromptAgentAlreadyCalledError,
  RebornLimitExceededError,
  RequiresAgentContextError,
  ResourceNotFoundError,
  RestoreError,
  SchemaConversionError,
  SnapshotDisabledError,
  ToolLoopExceededError,
  TurnBudgetExceededError,
} from "./core/domain/errors";
export {
  getAbortHandle,
  getContextSignal,
} from "./core/facade/async";

// ============ 5. Observability (Monitoring & Integration) ============

export type {
  AgentEndEvent,
  AgentRebornEvent,
  AgentStartEvent,
  BudgetUpdateEvent,
  CustomSpanEndEvent,
  CustomSpanStartEvent,
  ErrorEvent,
  EventType,
  GenerationEndEvent,
  GenerationEndReason,
  GenerationStartEvent,
  ModelCallEndEvent,
  ModelCallStartEvent,
  PromptAgentEndEvent,
  PromptAgentStartEvent,
  RunWithEndEvent,
  RunWithStartEvent,
  SysLogEvent,
  ToolsExecuteEndEvent,
  ToolsExecuteStartEvent,
  TraceEvent,
  TurnEndEvent,
  TurnStartEvent,
  ValidationFailEvent,
  ValidationSuccessEvent,
} from "./core/domain/events";
export { EVENTS, TRACE_EVENT_SCHEMA_VERSION } from "./core/domain/events";
export type { EventBus } from "./core/observability/event-bus";
export {
  createEventBus,
  getGlobalEventBus,
} from "./core/observability/event-bus";
export type { Span, TraceOptions } from "./core/observability/trace";
export { withCustomSpan } from "./core/observability/trace";

// ============ 6. Run ============

export type {
  AgentConfig,
  AgentForkOptions,
  AgentFunction,
  AgentHandler,
  AgentMiddleware,
  AgentMiddlewareContext,
  AgentReturn,
} from "./core/context/agent";
export type {
  RebornSignal,
  RunResult,
} from "./core/context/lifecycle";
export type { AgentFrameSnapshot, JournalEntry } from "./core/context/snapshot";
export type { ScopeLayer } from "./core/context/type";
export type {
  DraftViewModel,
  MiddlewareInfo,
  ToolSchema,
  TurnToolConfig,
} from "./core/domain/event-payload";
export type {
  ToolChoice,
  ToolContent,
  ToolContext,
  ToolDefinition,
  ToolHandlerResult,
  ToolMiddleware,
} from "./core/domain/tool";
export { isToolContent, TOOL_CONTENT_KEY, toolContent } from "./core/domain/tool";
export type { TraceContext } from "./core/domain/trace";
export { getUsageStats } from "./core/engine/budget-system";
export { type RunWithOptions, runWith } from "./core/facade/run";
export { promptChat } from "./core/policy/prompt-chat";
export { promptAgent } from "./core/policy/prompt-schema";
export type { AgentSnapshot } from "./core/snapshot/type";
