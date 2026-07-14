/**
 * Budget Equipment
 *
 * Functions for configuring budget limits and checking usage statistics.
 * Uses hierarchical budget tracking with parent-child agent monitoring.
 * BudgetState is stored in ctx.budgetState and is always updated,
 * even when no budget configs are set.
 */

import { getCurrentContext } from "../../context/accessor";
import type { BudgetConfig, BudgetRecord, BudgetUpdateArg } from "../../domain/budget";
import { AfterPromptAgentError, BudgetExceededError } from "../../domain/errors";

/**
 * Equip budget limit
 *
 * Adds budget configuration to the current agent context.
 * BudgetState is stored in ctx.budgetState and is always updated,
 * even when no budget configs are set. Use getUsageStats() to read current state.
 *
 * @param config - Budget configuration (e.g. onUpdate callback)
 *
 * @example
 * equipBudget({ onUpdate: ({ delta, aggregate }) => console.log('Updated', aggregate) });
 */
export function equipBudget(config: BudgetConfig): void {
  const ctx = getCurrentContext();

  if (ctx.draft.prompted) {
    throw new AfterPromptAgentError("equipBudget");
  }
  ctx.draft.budgetConfigs.push(config);
}

/**
 * Budget guard: returns a BudgetConfig that throws when limits are exceeded.
 * Checks run on each budget update; after checks pass, optional customOnUpdate is called.
 *
 * @deprecated Pending removal. No longer exported from the package barrel; retained only
 * for core's own tests. Callers should use `equipBudget({ onUpdate })` directly, or wait for
 * a future first-class `equipBudgetGuard`.
 *
 * @param limits - Optional maxCosts (per billing unit) and/or maxTotalTokens; exceeding either throws BudgetExceededError
 * @param customOnUpdate - Optional callback run after limits pass (e.g. logging, metrics)
 * @returns BudgetConfig suitable for equipBudget()
 *
 * @example
 * equipBudget(budgetGuard({ maxCosts: { micro_usd: 1_000_000 }, maxTotalTokens: 10_000 }));
 * equipBudget(budgetGuard({ maxTotalTokens: 5_000 }, ({ aggregate }) => console.log(aggregate)));
 */
export function budgetGuard(
  limits: { maxCosts?: BudgetRecord; maxTotalTokens?: number },
  customOnUpdate?: (arg: BudgetUpdateArg) => void,
): BudgetConfig {
  return {
    onUpdate: (arg) => {
      const { aggregate } = arg;

      if (limits.maxCosts) {
        for (const [unit, limit] of Object.entries(limits.maxCosts)) {
          const current = aggregate.costs[unit] ?? 0;
          if (current > limit) {
            throw new BudgetExceededError({
              kind: "cost",
              current,
              limit,
              costUnit: unit,
            });
          }
        }
      }
      if (limits.maxTotalTokens !== undefined && aggregate.totalTokens > limits.maxTotalTokens) {
        throw new BudgetExceededError({
          kind: "tokens",
          current: aggregate.totalTokens,
          limit: limits.maxTotalTokens,
        });
      }

      customOnUpdate?.(arg);
    },
  };
}
