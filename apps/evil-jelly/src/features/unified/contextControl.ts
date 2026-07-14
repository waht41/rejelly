import { getBinding } from "../../services/binding/hostBindings";
import type { PromptChatCompactionConfig } from "../../services/policy/promptChatResilient";
import { env } from "../../shared/config";

/** Default real model context window (tokens) when OPENAI_CONTEXT_WINDOW is unset. */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
/** Trigger mid-loop auto-compaction once estimated live context reaches this fraction of the window. */
const AUTO_COMPACT_THRESHOLD_RATIO = 0.75;
/** Verbatim token budget for the most recent user turns retained after an auto-compaction summary. */
const AUTO_COMPACT_KEEP_RECENT_USER_TOKENS = 6000;

/**
 * Context-checkpoint prompt, adapted from openai/codex's compaction prompt
 * (https://github.com/openai/codex, Apache-2.0). Drives the no-tools summarization call that
 * replaces the bulky working set so the same task can continue in a fresh, smaller window.
 * Shared by mid-loop auto-compaction and the manual /compress command (codex parity: manual and
 * auto compaction are one path, only the trigger differs).
 */
const AUTO_COMPACT_SUMMARY_INSTRUCTION = [
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Write a handoff summary that lets you (the",
  "same coding agent) resume this exact task after the bulky conversation above is discarded.",
  "",
  "Capture:",
  "- What the user asked for and any durable constraints or preferences.",
  "- Concrete progress: files created/edited/deleted and the essence of each change.",
  "- Key decisions, discovered facts, paths, commands, and verification results.",
  "- Which user requests were already answered, and which single request is currently live.",
  "- What remains to be done, as clear next steps.",
  "- Exact snippets, errors, or user instructions that must not be paraphrased away.",
  "",
  "Be concise and structured. Output ONLY the summary as plain markdown — do not call tools.",
  "Your output will be inserted into a <compaction_summary> block in the continued conversation,",
  "so do not emit the tag yourself.",
].join("\n");

/** Nudge appended to the last tool output as occupancy nears (but has not yet hit) the threshold. */
const AUTO_COMPACT_WARN_HINT =
  "[context filling: nearing the auto-compaction threshold. Auto-compaction preserves a summary but " +
  "can reduce accuracy — narrow further (grep / ast_document_symbols over full reads) to defer it.]";

/**
 * The single top-level context bound for the interactive coding loop: one occupancy-based governor
 * that nudges as context fills, then auto-compacts. (Kits no longer install per-tool intake pools.)
 * /compress reuses this exact config through promptCompactHistory, so manual and automatic
 * compaction cannot drift apart.
 */
export function buildAutoCompactionConfig(): PromptChatCompactionConfig {
  // Real model window: the hard ceiling the summarization request is proactively trimmed to fit.
  const contextWindow = env.OPENAI_CONTEXT_WINDOW ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  // Auto-compact trigger budget — kept SEPARATE from the window above (Codex's two-number design).
  // Override via OPENAI_AUTO_COMPACT_TOKENS (absolute, wins) or OPENAI_AUTO_COMPACT_RATIO
  // (fraction of the window) to force early compaction (e.g. in testing) without dragging the
  // trim ceiling down with it, which would stub the outputs the summary needs.
  const thresholdTokens =
    env.OPENAI_AUTO_COMPACT_TOKENS ??
    Math.floor(contextWindow * (env.OPENAI_AUTO_COMPACT_RATIO ?? AUTO_COMPACT_THRESHOLD_RATIO));
  return {
    thresholdTokens,
    contextWindowTokens: contextWindow,
    summaryInstruction: AUTO_COMPACT_SUMMARY_INSTRUCTION,
    keepRecentUserTokens: AUTO_COMPACT_KEEP_RECENT_USER_TOKENS,
    summaryPrefix: "## Auto-compacted checkpoint",
    warnHint: AUTO_COMPACT_WARN_HINT,
    onCompacted: ({ round, beforeTokens, afterTokens }) => {
      getBinding().logSystemEvent(
        `Context auto-compacted (round ${round}): ~${beforeTokens} → ~${afterTokens} tokens.\n`,
      );
    },
  };
}
