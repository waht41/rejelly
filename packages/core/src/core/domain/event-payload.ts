import type { JsonSchema } from "./model";
import type { ToolChoice } from "./tool";

/**
 * DevTool view model: cherry-picked from AgentRunDraft for display only.
 * Excludes journal, children, callCounters, validators, budgetConfigs
 * to avoid payload explosion and leaking internal engine details.
 */
export interface DraftViewModel {
  systemPrompts: string[];
  instructions: unknown[];
  /** Tool metadata only: name, description, parameters (JSON Schema), static middleware name+config; no handler */
  tools: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    middlewares?: { name: string; config?: Record<string, unknown> }[];
  }[];
  scopeLayers: Record<string, unknown>[];
  /** Keys of equipped resources */
  resourceKeys: string[];
}

// ============ Middleware Info (shared by model / tool / agent events) ============
/** Middleware info (name + config) for debug; used in model, tool, and agent events */
export interface MiddlewareInfo {
  name: string;
  config?: Record<string, unknown>;
}

/**
 * Serializable tool shape for telemetry (what is sent to the model).
 * Excludes handler; static middleware chain is only name + config (see middlewares).
 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Static middleware chain from ToolDefinition (augment); handlers omitted */
  middlewares?: MiddlewareInfo[];
}

/**
 * Tool-related options for a single logical turn (telemetry).
 * Nested so fields like parallel_tool_calls can be added later without bloating TurnStartEvent.
 */
export interface TurnToolConfig {
  /** Tools actually provided to the model for this attempt */
  tools: ToolSchema[];
  /** Effective tool choice selected by policy for this turn */
  toolChoice?: ToolChoice;
}
