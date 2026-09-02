/**
 * Budget and Statistics Types
 *
 * Types related to resource consumption monitoring.
 */

import type { JsonObjectLoose, JsonValue, Loose } from "../../utils/type";
import type { TokenUsage } from "./model";

/**
 * Flat budget ledger: keys are billing units (prefer micro_* prefixes, e.g. micro_usd),
 * values are absolute integer amounts (no floating-point currency).
 */
export type BudgetRecord = Record<string, number>;

/**
 * Model usage item
 */
export interface UsageTokens {
  prompt: number;
  completion: number;
  total: number;
  /** Extended token dimensions (e.g. reasoning, cacheRead). */
  details?: Record<string, number>;
}

export interface ModelUsageItem {
  type: "model"; // Discriminator
  name: string; // e.g., "gpt-4-turbo"
  /** Provider (e.g. "openai", "anthropic"); used in merge key */
  provider?: string;
  /** Financial amounts by billing unit (integers only at runtime; validated in budget-system) */
  costs: BudgetRecord;

  // Model-specific fields: Token structure
  tokens: UsageTokens;
}

/** Model-token attribution for an LLM call performed inside a tool operation. */
export interface ToolModelUsage {
  /** Billing/provider boundary, e.g. `openrouter` or `openai`. */
  provider?: string;
  model: string;
  tokens: UsageTokens;
}

/** Caller-facing form of ToolModelUsage using the standard adapter TokenUsage shape. */
export interface RecordToolModelUsageInput {
  provider?: string;
  model: string;
  usage: TokenUsage;
}

/**
 * Tool usage item
 */
export interface ToolUsageItem {
  type: "tool"; // Discriminator
  name: string; // e.g., "dall-e-3", "google_search"
  /** Financial amounts by billing unit (integers only at runtime) */
  costs: BudgetRecord;

  // Tool-specific fields: Generic metrics
  quantity: number; // e.g., 1, 500
  unit: string; // Physical dimension, e.g., "image", "ms", "request"

  /** Optional tool-specific details (e.g. resolution, format) */
  details?: JsonValue;

  /** Token-metered model calls performed as part of this tool operation. */
  modelUsages?: ToolModelUsage[];
}

/**
 * Input type for recordToolUsage.
 * Intentionally loose: allows undefined values in details (e.g. { resolution: "1080p", format: undefined }),
 * which will be sanitized before recording.
 */
export interface RecordToolUsageInput<T = JsonObjectLoose> {
  name: string;
  costs: BudgetRecord;
  quantity: number;
  unit: string;
  details?: Loose<T>;
  /** Optional model calls attributable to this tool; their tokens feed aggregate token budgets. */
  modelUsages?: readonly RecordToolModelUsageInput[];
}

/**
 * Union type for usage items
 */
export type UsageItem = ModelUsageItem | ToolUsageItem;

/**
 * Usage statistics for budget tracking
 */
export interface UsageStats {
  /** Aggregated financial amounts by billing unit */
  costs: BudgetRecord;

  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  callCount: number;

  /** Extended token dimensions (e.g. reasoningTokens, cacheReadTokens). Accumulated via generic loop. */
  details?: Record<string, number>;

  // Structured details (heterogeneous array)
  items: UsageItem[];
}

/**
 * Argument passed to BudgetConfig.onUpdate
 */
export interface BudgetUpdateArg {
  /** This update's usage delta */
  delta: UsageStats;
  /** Current context's aggregate usage (self + children) */
  aggregate: UsageStats;
  /** Current context's own usage (self only) */
  own: UsageStats;
}

/**
 * Budget configuration
 */
export interface BudgetConfig {
  /** Callback when budget is updated; called in chain order (current context then parents) */
  onUpdate: (arg: BudgetUpdateArg) => void;
}

/**
 * Budget state with own and aggregate usage
 *
 * - own: Current agent's direct consumption (self time)
 * - aggregate: Total consumption including all child agents (total time)
 */
export interface BudgetState {
  /**
   * Self consumption (Self Time)
   * Records Model and Tool calls made directly by current Agent.
   * Used for analyzing Agent's own behavior patterns.
   */
  own: UsageStats;

  /**
   * Aggregate consumption (Total Time)
   * Contains consumption from self and all child Agents combined.
   * Items are merged by (type + name) to keep flat.
   * Used for Budget circuit breaker checks.
   */
  aggregate: UsageStats;
}
