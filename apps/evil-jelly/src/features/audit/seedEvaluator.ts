/**
 * Shared per-seed evaluator factory (Phase 2, agentic precision layer). Each seed family supplies a
 * system prompt, an instruction builder for one native seed, and a verdict schema; this owns the
 * common wiring — read-only workspace kit, quiet concurrent fan-out, tool-loop budget — so a new
 * family adds judgment, not boilerplate (INV-0008 §4/§5).
 *
 * Quiet: evaluators run as many concurrent fan-out workers; tool chatter / streamed text must not
 * interleave on the shared terminal. Progress + the final report come from AuditAgent; per-seed
 * detail lives in the trace (hence no useStandardStreaming either).
 */

import { createAgent, equipInstruction, equipSystem, promptAgent } from "@rejelly/core";
import { z } from "zod";
import { equipContextIntakeBudgetMiddleware } from "../../tools/hooks/contextIntakeBudget";
import { equipToolLoopBudgetMiddleware } from "../../tools/hooks/toolLoopBudget";
import { equipReadOnlyWorkspaceKit, READ_ONLY_WORKSPACE_TOOL_NAMES } from "../../tools/kits";
import { AUDIT_DEFAULTS, type SeedVerdict } from "./types";

/**
 * Build a family verdict schema sharing the common shape (isActionable / severity / summary /
 * rationale / proposal) but with a family-specific `category` enum + wording. The inferred type is
 * assignable to {@link SeedVerdict} (category enum ⊂ string).
 */
export function makeVerdictSchema<const C extends readonly [string, ...string[]]>(opts: {
  actionableDescribe: string;
  categories: C;
  categoryDescribe: string;
}) {
  return z.object({
    isActionable: z.boolean().describe(opts.actionableDescribe),
    severity: z
      .enum(["high", "medium", "low"])
      .describe(
        "Refactor priority: high = substantial real risk; medium = worth doing but contained; " +
          "low = minor or cosmetic. Use low when isActionable is false.",
      ),
    category: z.enum(opts.categories).describe(opts.categoryDescribe),
    summary: z.string().describe("One sentence: what the issue is and where (no code, no fences)."),
    rationale: z
      .string()
      .describe(
        "Why it is (or isn't) worth refactoring; name the concrete risk or why it is fine.",
      ),
    proposal: z
      .string()
      .describe(
        "Concrete refactor plan when actionable: what to change and how, respecting the layering " +
          "cascade (cli → shell → feature → tools → service → shared). Empty string otherwise.",
      ),
  });
}

export interface SeedEvaluatorConfig<TNative, TVerdict extends SeedVerdict> {
  /** Agent id (used in traces and the tool-loop budget name). */
  id: string;
  /** System prompt framing the family's judgment task. */
  systemPrompt: string;
  /** Build the per-seed instruction (embeds the candidate's source slices). */
  buildInstruction: (native: TNative) => Promise<string>;
  /** Family verdict schema (see {@link makeVerdictSchema}). */
  schema: z.ZodType<TVerdict>;
}

/** Create a read-only per-seed evaluator agent for one family. */
export function makeSeedEvaluatorAgent<TNative, TVerdict extends SeedVerdict>(
  config: SeedEvaluatorConfig<TNative, TVerdict>,
) {
  return createAgent<{ native: TNative }, TVerdict>({
    id: config.id,
    maxTurnSteps: AUDIT_DEFAULTS.perSeedMaxTurnSteps,
    handler: async ({ native }) => {
      equipSystem(config.systemPrompt);
      equipInstruction(await config.buildInstruction(native));

      await equipReadOnlyWorkspaceKit({ quiet: true });
      // Read-only fan-out with no auto-compaction: a hard per-seed intake ceiling is this worker's
      // top-level context/cost bound. Declared explicitly here rather than hidden inside the kit.
      equipContextIntakeBudgetMiddleware({
        name: `${config.id}-context-intake-budget`,
        maxTokens: AUDIT_DEFAULTS.perSeedIntakeTokens,
        budgetedTools: READ_ONLY_WORKSPACE_TOOL_NAMES,
      });
      equipToolLoopBudgetMiddleware({
        maxTurnSteps: AUDIT_DEFAULTS.perSeedMaxTurnSteps,
        name: `${config.id}-tool-loop-budget`,
      });

      return await promptAgent(config.schema);
    },
  });
}
