/**
 * Mirror of `EVENTS` in packages/core/src/core/observability/events.ts.
 * Duplicated for devtool-ui browser bundle: value imports from @rejelly/core resolve the package
 * entry and can pull Node-only code (e.g. crypto-random). Types still come via `import type` from core.
 * Keep in sync when core adds or renames event type strings.
 */
export const EVENTS = {
  AGENT_START: "agent:start",
  AGENT_END: "agent:end",
  AGENT_REBORN: "agent:reborn",
  GENERATION_START: "generation:start",
  GENERATION_END: "generation:end",
  PROMPT_AGENT_START: "promptAgent:start",
  PROMPT_AGENT_END: "promptAgent:end",
  TURN_START: "turn:start",
  TURN_END: "turn:end",
  ATTEMPT_START: "attempt:start",
  ATTEMPT_END: "attempt:end",
  VALIDATION_FAIL: "validation:fail",
  VALIDATION_SUCCESS: "validation:success",
  ERROR: "error",
  SYS_LOG: "sys:log",
  MODEL_CALL_START: "model:call:start",
  MODEL_CALL_END: "model:call:end",
  CUSTOM_SPAN_START: "custom:span:start",
  CUSTOM_SPAN_END: "custom:span:end",
  TOOLS_EXECUTE_START: "tools:execute:start",
  TOOLS_EXECUTE_END: "tools:execute:end",
  RUN_WITH_START: "runWith:start",
  RUN_WITH_END: "runWith:end",
  BUDGET_UPDATE: "budget:update",
  RESOURCE_OP_START: "resource:op:start",
  RESOURCE_OP_END: "resource:op:end",
  INSTRUMENT_OP_START: "instrument:op:start",
  INSTRUMENT_OP_END: "instrument:op:end",
} as const;
