/**
 * Telemetry
 *
 * Event emission and handling for debugging and observability.
 */

import { sanitizeForJson, sanitizeUndefined } from "../../utils/object";
import {
  type AgentEndEvent,
  type AgentRebornEvent,
  type AgentStartEvent,
  type BudgetUpdateEvent,
  type CustomSpanEndEvent,
  type CustomSpanStartEvent,
  type ErrorEvent,
  EVENTS,
  type GenerationEndEvent,
  type GenerationStartEvent,
  type InstrumentOpEndEvent,
  type InstrumentOpStartEvent,
  type ModelCallEndEvent,
  type ModelCallStartEvent,
  type PromptAgentEndEvent,
  type PromptAgentStartEvent,
  type ResourceOpEndEvent,
  type ResourceOpStartEvent,
  type RunWithEndEvent,
  type RunWithStartEvent,
  type SysLogEvent,
  type ToolsExecuteEndEvent,
  type ToolsExecuteStartEvent,
  TRACE_EVENT_SCHEMA_VERSION,
  type TraceEvent,
  type TurnEndEvent,
  type TurnStartEvent,
  type ValidationFailEvent,
  type ValidationSuccessEvent,
} from "../domain/events";
import type { TraceContext } from "../domain/trace";

// ============ Types ============

/**
 * Emit function type
 */
export type EmitFn = (event: TraceEvent) => void;

// ============ Trace ID Generation ============

// ============ Emitter Factory ============

/**
 * Extract event-specific props (omit base fields)
 */
export type EventProps<T extends TraceEvent> = Omit<
  T,
  "schemaVersion" | "type" | "trace" | "timestamp" | "agentId"
>;

/**
 * Emitter interface
 */
export interface Emitter {
  agentStart(props: EventProps<AgentStartEvent>): void;
  agentEnd(props: EventProps<AgentEndEvent>): void;
  agentReborn(props: EventProps<AgentRebornEvent>): void;
  generationStart(props: EventProps<GenerationStartEvent>): void;
  generationEnd(props: EventProps<GenerationEndEvent>): void;
  promptAgentStart(props: EventProps<PromptAgentStartEvent>): void;
  promptAgentEnd(props: EventProps<PromptAgentEndEvent>): void;
  turnStart(props: EventProps<TurnStartEvent>): void;
  turnEnd(props: EventProps<TurnEndEvent>): void;
  validationFail(props: EventProps<ValidationFailEvent>): void;
  validationSuccess(props: EventProps<ValidationSuccessEvent>): void;
  error(props: EventProps<ErrorEvent>): void;
  toolsExecuteStart(props: EventProps<ToolsExecuteStartEvent>): void;
  toolsExecuteEnd(props: EventProps<ToolsExecuteEndEvent>): void;
  runWithStart(props: EventProps<RunWithStartEvent>): void;
  runWithEnd(props: EventProps<RunWithEndEvent>): void;
  modelCallStart(props: EventProps<ModelCallStartEvent>): void;
  /** End of model call; props may include ttft, usage (with details.reasoningTokens), finishReason */
  modelCallEnd(props: EventProps<ModelCallEndEvent>): void;
  sysLog(props: EventProps<SysLogEvent>): void;
  budgetUpdate(props: EventProps<BudgetUpdateEvent>): void;
  customSpanStart(props: EventProps<CustomSpanStartEvent>): void;
  customSpanEnd(props: EventProps<CustomSpanEndEvent>): void;
  resourceOpStart(props: EventProps<ResourceOpStartEvent>): void;
  resourceOpEnd(props: EventProps<ResourceOpEndEvent>): void;
  instrumentOpStart(props: EventProps<InstrumentOpStartEvent>): void;
  instrumentOpEnd(props: EventProps<InstrumentOpEndEvent>): void;
}

/**
 * Create event emitter for a specific trace context
 *
 * @param originEmit - Raw emit function to dispatch events
 * @param trace - Trace context
 * @param agentId - Agent ID
 * @returns Emitter object with methods for each event type
 */
export function createEmitter(originEmit: EmitFn, trace: TraceContext, agentId?: string): Emitter {
  const emit = (event: TraceEvent) => {
    // Drop undefined keys first so sanitizeForJson does not stringify them as "[undefined]"
    const cleaned = sanitizeUndefined(event);
    originEmit(sanitizeForJson(cleaned ?? event) as TraceEvent);
  };

  const base = (): Pick<TraceEvent, "agentId" | "schemaVersion" | "timestamp" | "trace"> => ({
    agentId,
    schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
    timestamp: Date.now(),
    trace,
  });

  return {
    agentStart(props) {
      emit({ type: EVENTS.AGENT_START, ...base(), ...props });
    },

    agentEnd(props) {
      emit({ type: EVENTS.AGENT_END, ...base(), ...props });
    },

    agentReborn(props) {
      emit({ type: EVENTS.AGENT_REBORN, ...base(), ...props });
    },

    generationStart(props) {
      emit({ type: EVENTS.GENERATION_START, ...base(), ...props });
    },

    generationEnd(props) {
      emit({ type: EVENTS.GENERATION_END, ...base(), ...props });
    },

    promptAgentStart(props) {
      emit({ type: EVENTS.PROMPT_AGENT_START, ...base(), ...props });
    },

    promptAgentEnd(props) {
      emit({ type: EVENTS.PROMPT_AGENT_END, ...base(), ...props });
    },

    turnStart(props) {
      emit({ type: EVENTS.TURN_START, ...base(), ...props });
    },

    turnEnd(props) {
      emit({ type: EVENTS.TURN_END, ...base(), ...props });
    },

    validationFail(props) {
      emit({ type: EVENTS.VALIDATION_FAIL, ...base(), ...props });
    },

    validationSuccess(props) {
      emit({ type: EVENTS.VALIDATION_SUCCESS, ...base(), ...props });
    },

    error(props) {
      emit({ type: EVENTS.ERROR, ...base(), ...props });
    },

    toolsExecuteStart(props) {
      emit({ type: EVENTS.TOOLS_EXECUTE_START, ...base(), ...props });
    },

    toolsExecuteEnd(props) {
      emit({ type: EVENTS.TOOLS_EXECUTE_END, ...base(), ...props });
    },

    runWithStart(props) {
      emit({ type: EVENTS.RUN_WITH_START, ...base(), ...props });
    },

    runWithEnd(props) {
      emit({ type: EVENTS.RUN_WITH_END, ...base(), ...props });
    },

    modelCallStart(props) {
      emit({ type: EVENTS.MODEL_CALL_START, ...base(), ...props });
    },

    modelCallEnd(props) {
      emit({ type: EVENTS.MODEL_CALL_END, ...base(), ...props });
    },

    sysLog(props) {
      emit({ type: EVENTS.SYS_LOG, ...base(), ...props });
    },

    budgetUpdate(props) {
      emit({ type: EVENTS.BUDGET_UPDATE, ...base(), ...props });
    },

    customSpanStart(props) {
      emit({ type: EVENTS.CUSTOM_SPAN_START, ...base(), ...props });
    },

    customSpanEnd(props) {
      emit({ type: EVENTS.CUSTOM_SPAN_END, ...base(), ...props });
    },

    resourceOpStart(props) {
      emit({ type: EVENTS.RESOURCE_OP_START, ...base(), ...props });
    },

    resourceOpEnd(props) {
      emit({ type: EVENTS.RESOURCE_OP_END, ...base(), ...props });
    },

    instrumentOpStart(props) {
      emit({ type: EVENTS.INSTRUMENT_OP_START, ...base(), ...props });
    },

    instrumentOpEnd(props) {
      emit({ type: EVENTS.INSTRUMENT_OP_END, ...base(), ...props });
    },
  };
}
