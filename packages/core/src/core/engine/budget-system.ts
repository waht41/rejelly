/**
 * Budget Monitoring System
 *
 * Provides hierarchical budget tracking with parent-child agent monitoring.
 * Uses context chain to track consumption across agent boundaries.
 */

import { safeClone, sanitizeUndefined, stableStringify } from "../../utils/object";
import type { JsonObjectLoose } from "../../utils/type";
import { getCurrentContext, getCurrentContextSafe } from "../context/accessor";
import { getContextStore } from "../context/store";
import type { AgentContext } from "../context/type";
import type {
  BudgetState,
  ModelUsageItem,
  RecordToolModelUsageInput,
  RecordToolUsageInput,
  ToolModelUsage,
  ToolUsageItem,
  UsageItem,
  UsageStats,
  UsageTokens,
} from "../domain/budget";
import { InvalidCostValueError } from "../domain/errors";
import type { ModelAdapter, TokenUsage } from "../domain/model";
import type { TraceContext } from "../domain/trace";
import { resolveEventBus } from "../observability/event-bus";
import { createEmitter } from "../observability/telemetry";
import { generateSpanId } from "../shared/id";
import { logger } from "../shared/logger/instance";

/** Merge key: model by (type + provider + name); tool by (type + name + unit + details) */
function itemMergeKey(item: UsageItem): string {
  if (item.type === "model") return `model:${item.provider ?? ""}:${item.name}`;
  return `tool:${item.name}:${item.unit}:${stableStringify(item.details)}`;
}

/**
 * [Guard] Strict integer validation for cost dictionaries (no float financial amounts).
 */
function validateAndCloneCosts(
  costs: Record<string, number>,
  source: string,
): Record<string, number> {
  const safeCosts: Record<string, number> = {};
  for (const [key, value] of Object.entries(costs)) {
    if (typeof value !== "number") {
      throw new InvalidCostValueError({
        billingUnit: key,
        source,
        reason: "not_number",
        value,
      });
    }
    if (!Number.isFinite(value)) {
      throw new InvalidCostValueError({
        billingUnit: key,
        source,
        reason: "not_finite",
        value,
      });
    }
    if (!Number.isInteger(value)) {
      throw new InvalidCostValueError({
        billingUnit: key,
        source,
        reason: "not_integer",
        value,
      });
    }
    safeCosts[key] = value;
  }
  return safeCosts;
}

/**
 * Merge delta costs into target (mutates target).
 */
function mergeCosts(target: Record<string, number>, delta: Record<string, number>): void {
  for (const [key, value] of Object.entries(delta)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function mergeUsageTokens(target: UsageTokens, delta: UsageTokens): void {
  target.prompt += delta.prompt;
  target.completion += delta.completion;
  target.total += delta.total;
  if (delta.details) {
    target.details ??= {};
    for (const [key, value] of Object.entries(delta.details)) {
      target.details[key] = (target.details[key] ?? 0) + value;
    }
  }
}

function mergeToolModelUsages(target: ToolModelUsage[], delta: ToolModelUsage[]): void {
  for (const incoming of delta) {
    const existing = target.find(
      (usage) => usage.provider === incoming.provider && usage.model === incoming.model,
    );
    if (existing) {
      mergeUsageTokens(existing.tokens, incoming.tokens);
    } else {
      target.push(safeClone(incoming));
    }
  }
}

/**
 * Merge usage items
 *
 * Merges delta items into target items. Model items aggregated by (type + provider + name).
 * Tool items aggregated by (type + name + unit + details); different unit/details are separate items.
 *
 * @param targetItems - Target items array to merge into
 * @param deltaItems - Delta items to merge
 */
function mergeItems(targetItems: UsageItem[], deltaItems: UsageItem[]): void {
  for (const newItem of deltaItems) {
    const existing = targetItems.find((i) => itemMergeKey(i) === itemMergeKey(newItem));

    if (existing) {
      if (!existing.costs) existing.costs = {};
      mergeCosts(existing.costs, newItem.costs);

      if (existing.type === "model" && newItem.type === "model") {
        // Merge model tokens
        mergeUsageTokens(existing.tokens, newItem.tokens);
      } else if (existing.type === "tool" && newItem.type === "tool") {
        // Merge tool quantity
        existing.quantity += newItem.quantity;
        if (newItem.modelUsages) {
          existing.modelUsages ??= [];
          mergeToolModelUsages(existing.modelUsages, newItem.modelUsages);
        }
      }
    } else {
      // Add new item with copied refs so own/aggregate do not share same object refs
      const itemClone = safeClone(newItem);
      targetItems.push(itemClone);
    }
  }
}

function normalizeUsageTokens(usage: TokenUsage, source: string): UsageTokens {
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  const total = usage.totalTokens ?? prompt + completion;
  let details: Record<string, number> | undefined;
  if (usage.details) {
    for (const [key, value] of Object.entries(usage.details)) {
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(
          `${source}.details[${JSON.stringify(key)}] must be a finite number, got ${typeof value}: ${value}`,
        );
      }
      details ??= {};
      details[key] = value;
    }
  }
  return { prompt, completion, total, ...(details !== undefined && { details }) };
}

function normalizeToolModelUsages(
  inputs: readonly RecordToolModelUsageInput[] | undefined,
): ToolModelUsage[] | undefined {
  if (!inputs || inputs.length === 0) {
    return undefined;
  }
  const normalized: ToolModelUsage[] = [];
  for (const input of inputs) {
    const incoming: ToolModelUsage = {
      ...(input.provider !== undefined && { provider: input.provider }),
      model: input.model,
      tokens: normalizeUsageTokens(input.usage, `ToolModelUsage[${input.model}]`),
    };
    mergeToolModelUsages(normalized, [incoming]);
  }
  return normalized;
}

/**
 * Merge usage stats
 *
 * Merges delta into target. Model items by (type + provider + name); tool items by (type + name + unit + details).
 * Matching items are merged (costs/tokens/quantity accumulated).
 *
 * @param target - Target stats to merge into
 * @param delta - Delta stats to merge
 */
function mergeStats(target: UsageStats, delta: UsageStats): void {
  if (!target.costs) target.costs = {};
  mergeCosts(target.costs, delta.costs ?? {});

  target.totalTokens += delta.totalTokens;
  target.promptTokens += delta.promptTokens;
  target.completionTokens += delta.completionTokens;
  target.callCount += delta.callCount;

  // Merge extended token dimensions (generic accumulation)
  if (delta.details) {
    if (!target.details) target.details = {};
    for (const [key, value] of Object.entries(delta.details)) {
      target.details[key] = (target.details[key] ?? 0) + value;
    }
  }

  // Merge items
  mergeItems(target.items, delta.items);
}

/**
 * Update budget state chain
 *
 * Iteratively updates the budget chain, ensuring that shared budget states
 * are effectively deduplicated to avoid double counting.
 * Updates own and aggregate stats for current context and all parent contexts.
 *
 * @param ctx - Agent context
 * @param delta - Usage delta to record
 * @param isSelf - Whether this consumption is from current agent (true) or child (false)
 */
export function updateBudgetChain(ctx: AgentContext, delta: UsageStats, isSelf: boolean): void {
  let current: AgentContext | undefined = ctx;
  let isFirstContext = true;

  while (current) {
    const currentState = current.budgetState;
    const configs = current.draft.budgetConfigs;

    // 1. Update own stats (only for the initiating context)
    if (isFirstContext && isSelf) {
      mergeStats(currentState.own, delta);
    }

    // 2. Update aggregate stats
    // This happens once per unique budgetState object encountered
    mergeStats(currentState.aggregate, delta);

    // 3. Call onUpdate for each config in chain order (pass clones so callback cannot mutate internal state)
    for (const config of configs) {
      getContextStore().run(
        current,
        () =>
          config.onUpdate({
            delta: safeClone(delta),
            aggregate: safeClone(currentState.aggregate),
            own: safeClone(currentState.own),
          }),
        {
          incDepth: false,
          parentContext: current.parentContext ?? null,
        },
      );
    }

    // 4. Move up the chain
    // CRITICAL FIX: Skip parent contexts that share the EXACT SAME budgetState object instance.
    // This handles ctx.scope() or any other mechanism that shares persistence.
    let next: AgentContext | undefined = current.parentContext;
    while (next && next.budgetState === currentState) {
      next = next.parentContext;
    }

    current = next;
    isFirstContext = false;
  }

  // Emit budget:update once at the start (initiating context's agentId/trace)
  if (ctx.trace) {
    const eventBus = resolveEventBus(ctx.eventBus);
    const trace: TraceContext = {
      traceId: ctx.trace.traceId,
      spanId: generateSpanId(),
      parentSpanId: ctx.trace.spanId,
    };
    const emitter = createEmitter(eventBus.emit, trace, ctx.agentId);
    emitter.budgetUpdate({
      identifiers: delta.items.map(itemMergeKey),
      delta: safeClone(delta),
      aggregate: safeClone(ctx.budgetState.aggregate),
      own: safeClone(ctx.budgetState.own),
    });
  }
}

/**
 * Record tool usage
 *
 * Records tool consumption to budget chain for tracking and budget checking.
 * Useful for tracking external API calls, image generation, or other tool-based resources.
 *
 * @param toolUsage - Tool usage item (without type field, which is automatically set to 'tool')
 */
export function recordToolUsage<T = JsonObjectLoose>(toolUsage: RecordToolUsageInput<T>): void {
  const ctx = getCurrentContextSafe();
  if (!ctx) {
    logger.warn("record tool usage out of Agent Context");
    return;
  }

  const details = toolUsage.details;
  const cleanedDetails = sanitizeUndefined(details);
  const modelUsages = normalizeToolModelUsages(toolUsage.modelUsages);

  const validatedCosts = validateAndCloneCosts(toolUsage.costs, `Tool[${toolUsage.name}]`);

  const toolItem: ToolUsageItem = safeClone({
    type: "tool",
    name: toolUsage.name,
    costs: validatedCosts,
    quantity: toolUsage.quantity,
    unit: toolUsage.unit,
    ...(cleanedDetails !== undefined && { details: cleanedDetails }),
    ...(modelUsages !== undefined && { modelUsages }),
  }) as ToolUsageItem;

  const tokens: UsageTokens = { prompt: 0, completion: 0, total: 0 };
  for (const modelUsage of modelUsages ?? []) {
    mergeUsageTokens(tokens, modelUsage.tokens);
  }

  const delta: UsageStats = {
    costs: safeClone(validatedCosts),
    promptTokens: tokens.prompt,
    completionTokens: tokens.completion,
    totalTokens: tokens.total,
    callCount: 1,
    ...(tokens.details !== undefined && { details: safeClone(tokens.details) }),
    items: [toolItem],
  };

  // Record to budget chain (always updates, even without configs)
  updateBudgetChain(ctx, delta, true);
}

/**
 * Record usage after LLM call
 *
 * - Normalizes token usage and calculates cost.
 * - Records to budget chain (hierarchical tracking), triggers onUpdate callbacks.
 *
 * @param ctx - Agent context
 * @param model - Model adapter
 * @param usage - Token usage from this call
 */
export function recordLLMUsage(
  ctx: AgentContext,
  model: ModelAdapter,
  usage: TokenUsage | undefined,
): void {
  if (!usage) return;

  const tokens = normalizeUsageTokens(usage, "TokenUsage");
  const promptTokens = tokens.prompt;
  const completionTokens = tokens.completion;
  const totalTokens = tokens.total;

  const rawCosts = model.calculateCost?.(usage) ?? {};
  const validatedCosts = validateAndCloneCosts(rawCosts, `Model[${model.id}]`);

  const details = tokens.details;

  const delta: UsageStats = {
    promptTokens,
    completionTokens,
    totalTokens,
    costs: safeClone(validatedCosts),
    callCount: 1,
    ...(details !== undefined && { details }),
    items: [
      {
        type: "model",
        name: model.id,
        ...(model.provider !== undefined && { provider: model.provider }),
        costs: safeClone(validatedCosts),
        tokens: {
          prompt: promptTokens,
          completion: completionTokens,
          total: totalTokens,
          ...(details !== undefined && { details }),
        },
      } as ModelUsageItem,
    ],
  };

  updateBudgetChain(ctx, delta, true);
}

/**
 * Get current usage statistics
 *
 * @returns Cloned budget state
 *
 * @example
 * const budgetState = getUsageStats();
 * console.log(`Used ${budgetState.aggregate.totalTokens} tokens, costs`, budgetState.aggregate.costs);
 */
export function getUsageStats(): BudgetState {
  const ctx = getCurrentContext();
  return safeClone(ctx.budgetState);
}
