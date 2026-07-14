/**
 * Snapshot
 *
 * Captures serializable state from AgentContext for debugging and observability.
 * Draft is exposed as DraftViewModel only (cherry-picked fields), never full AgentRunDraft.
 */

import { sanitizeForJson } from "../../utils/object";
import type { AgentContext, AgentRunDraft } from "../context/type";
import type { DraftViewModel } from "../domain/event-payload";
import { toolDefinitionsToToolSchemas } from "./tool-schema";

/** Keys of active equipped resources. */
export function collectResourceKeys(ctx: AgentContext): string[] {
  const keys = [...(ctx.resources?.active.keys() ?? [])];
  keys.sort();
  return keys;
}

/** Sanitized scope layers for trace / DraftViewModel (same mapping as toDraftViewModel) */
export function snapshotDraftScopeLayers(draft: AgentRunDraft): Record<string, unknown>[] {
  return draft.scopeLayers.map((layer) => sanitizeForJson(layer) as Record<string, unknown>);
}

/**
 * Build DevTool view model from engine draft (cherry-picked fields only).
 * Excludes journal, children, callCounters, validators, budgetConfigs.
 */
export function toDraftViewModel(draft: AgentRunDraft, ctx: AgentContext): DraftViewModel {
  const tools = toolDefinitionsToToolSchemas(draft.tools);

  const instructions = draft.instructions.map((item) => sanitizeForJson(item));

  const scopeLayers = snapshotDraftScopeLayers(draft);

  return {
    systemPrompts: [...draft.systemPrompts],
    instructions,
    tools,
    scopeLayers,
    resourceKeys: collectResourceKeys(ctx),
  };
}
