import type { Message } from "@rejelly/core";
import { isAbortError, isModelCallError } from "@rejelly/core";
import { executeTurn, isInstructionMessage, type PromptContext } from "@rejelly/core/policy";
import {
  renderPseudoXmlElement,
  selectPseudoXmlBoundaryTag,
  unwrapPseudoXmlElement,
} from "../../shared/lib/pseudoXml";
import {
  estimateMessagesTokens,
  estimateTokens,
  messageContentToText,
} from "../../shared/lib/tokens";

/**
 * Mid-loop context auto-compaction, adapted from openai/codex's mid-turn compaction
 * (https://github.com/openai/codex, Apache-2.0): when the estimated live context crosses a
 * threshold during the tool-call loop, summarize the working set, keep the most recent user
 * turns verbatim, and continue in place - bounding the live window across an unbounded task.
 */
export interface PromptChatCompactionConfig {
  /** Estimated live-context token count at/above which a compaction round is triggered. */
  thresholdTokens: number;
  /** Instruction handed to the summarization model call (the "checkpoint" prompt). */
  summaryInstruction: string;
  /**
   * Real model context window (tokens) - the hard ceiling the summarization request is proactively
   * trimmed to fit (Codex `model_context_window`). MUST be a separate value from `thresholdTokens`:
   * the trigger budget can be lowered to force early compaction without dragging this ceiling down
   * with it (which would stub the outputs the summary needs and cause a re-read livelock). Omit to
   * disable proactive trimming (a genuine over-window request then still falls back to the reactive
   * context-length retry).
   */
  contextWindowTokens?: number;
  /** Verbatim token budget for the most recent user turns kept after the summary. */
  keepRecentUserTokens?: number;
  /** Max compaction rounds per run (safety valve against summary-that-never-shrinks loops). */
  maxRounds?: number;
  /** Header prepended to the generated summary in the replacement history. */
  summaryPrefix?: string;
  /** Observer fired after each successful compaction round (logging / telemetry). */
  onCompacted?: (info: CompactionRoundInfo) => void;
  /**
   * Fraction of `thresholdTokens` at which to start softly nudging the model (below the compaction
   * trigger). Only takes effect when `warnHint` is set. Default 0.8.
   */
  warnRatio?: number;
  /**
   * One-line hint appended to the last tool output while estimated occupancy sits in the warn band
   * (`warnRatio * threshold <= occupancy < threshold`), so the model can narrow or checkpoint before
   * an accuracy-costing auto-compaction fires.
   */
  warnHint?: string;
}

export interface CompactionRoundInfo {
  round: number;
  beforeTokens: number;
  afterTokens: number;
  keptUserMessages: number;
}

export const DEFAULT_COMPACTION_MAX_ROUNDS = 4;
export const DEFAULT_WARN_RATIO = 0.8;

/**
 * Stream-event channel tag on the summarization side-turn. Its output is an internal handoff
 * (recorded into history, surfaced via `onCompacted`), not a reply - user-facing stream consumers
 * must skip this channel so the summary never renders as if the agent had answered.
 */
export const COMPACTION_STREAM_CHANNEL = "compaction";

const DEFAULT_KEEP_RECENT_USER_TOKENS = 6000;
const DEFAULT_SUMMARY_PREFIX = "## Summary of prior work (auto-compacted)";
/**
 * Fraction of the real model window the proactive trim fits under. The remainder reserves room for
 * the generated summary (a plain sampling call, unlike Codex's dedicated compact endpoint, spends
 * output tokens against the same window) plus slack for the token estimator, which under-charges.
 */
const COMPACTION_REQUEST_INPUT_RATIO = 0.85;
/** Max attempts to fit the summarization request (1 proactive + context-length retries) before giving up. */
const COMPACTION_SUMMARY_FIT_ATTEMPTS = 4;
/** Each context-length retry trims the request to this fraction of its current estimate. */
const COMPACTION_SUMMARY_SHRINK_RATIO = 0.5;
const COMPACTION_REQUEST_TRUNCATED_OUTPUT =
  "[Output omitted: truncated to fit the compaction request within the model context window.]";
/**
 * Tag wrapping each kept user turn in the compacted history. The kept turns and the bridge
 * message are consecutive user-role messages with no assistant reply between them, so the model
 * reads them as one user turn (strict-alternation providers even receive them flattened by the
 * adapter's `mergeConsecutiveSameRoleMessages`) — without an explicit boundary it cannot tell
 * where one historical turn ends and the next begins. Past-tense name on purpose: the turns must
 * read as already-received history, not as fresh input awaiting an answer.
 */
const PRIOR_USER_MESSAGE_TAG = "prior_user_message";
/** Tag fencing the model-generated summary so its free text cannot read as new user input. */
const COMPACTION_SUMMARY_TAG = "compaction_summary";
/**
 * Stable lead-in shared by every notice format ever persisted; the cross-round re-collection
 * filter keys on this so bridge messages from older rounds (including pre-reorder histories,
 * where the notice was a standalone user message) are never picked up as kept user turns. Any
 * format change must keep this exact lead-in (tags go after it, never around the whole message).
 */
const COMPACTION_NOTICE_PREFIX = "[Context was automatically compacted";
const COMPACTION_NOTICE =
  `${COMPACTION_NOTICE_PREFIX} to fit the model window. The most recent user turns are retained ` +
  `verbatim above, each inside a <${PRIOR_USER_MESSAGE_TAG}> block; any of them already handled ` +
  "are covered in the summary below — do not answer them again. Continue the current task from " +
  `the summary inside <${COMPACTION_SUMMARY_TAG}>.]`;

/**
 * Codex-parity fit guard (openai/codex `trim_function_call_history_to_fit_context_window`,
 * Apache-2.0): the summarization request carries the entire working set - the same bulk that tripped
 * compaction - so it can itself exceed the model window when a single turn's tool outputs overshoot
 * between threshold checks. Stub tool-output message bodies newest-first (leaving the older, cacheable
 * prefix intact and preferentially dropping the recent outputs that caused the overshoot) until the
 * estimate fits under `maxTokens`. Returns the input unchanged when it already fits or nothing is left
 * to reclaim.
 *
 * The fit target MUST be the real model window, never the (lower) auto-compact trigger budget:
 * trimming to the trigger stubs the outputs the summary needs even though they would fit the real
 * request, yielding a "content omitted, must re-read" summary that makes the agent redo work. Keyed
 * to the real window, a normal compaction (which fires well below it) stays lossless.
 */
export function truncateToolOutputsToFit(messages: Message[], maxTokens: number): Message[] {
  if (maxTokens <= 0) {
    return messages;
  }
  let total = estimateMessagesTokens(messages);
  if (total <= maxTokens) {
    return messages;
  }
  const placeholderCost = estimateTokens(COMPACTION_REQUEST_TRUNCATED_OUTPUT);
  const trimmed = [...messages];
  for (let index = trimmed.length - 1; index >= 0 && total > maxTokens; index -= 1) {
    const message = trimmed[index];
    if (message.role !== "tool") {
      continue;
    }
    const currentCost = estimateTokens(messageContentToText(message.content));
    if (currentCost <= placeholderCost) {
      continue;
    }
    trimmed[index] = { ...message, content: COMPACTION_REQUEST_TRUNCATED_OUTPUT };
    total -= currentCost - placeholderCost;
  }
  return trimmed;
}

/**
 * Most-recent user turns kept verbatim within a token budget (Codex `collect_user_messages`
 * analog). The single most recent user turn is always kept so the live task text survives even
 * when it alone exceeds the budget.
 */
export function selectRecentUserMessages(messages: Message[], maxTokens: number): Message[] {
  const users = messages.filter(
    (message) => message.role === "user" && !isInstructionMessage(message),
  );
  const picked: Message[] = [];
  let remaining = maxTokens;
  for (let index = users.length - 1; index >= 0; index -= 1) {
    const cost = estimateTokens(messageContentToText(users[index].content));
    if (cost <= remaining) {
      picked.push(users[index]);
      remaining -= cost;
    } else {
      break;
    }
  }
  if (picked.length === 0 && users.length > 0) {
    picked.push(users[users.length - 1]);
  }
  return picked.reverse();
}

/**
 * Wrap a kept user turn's content in the `<prior_user_message>` boundary. Idempotent: kept turns
 * re-collected by a later compaction round arrive already wrapped and must not gain nested tags.
 * Non-text parts (images) survive by fencing with separate text parts around the original parts.
 */
function wrapPriorUserMessage(message: Message): Message {
  const text = messageContentToText(message.content).trim();
  if (unwrapPseudoXmlElement(text, PRIOR_USER_MESSAGE_TAG) !== undefined) {
    return message;
  }
  if (message.content == null || typeof message.content === "string") {
    return {
      ...message,
      content: renderPseudoXmlElement(PRIOR_USER_MESSAGE_TAG, message.content ?? ""),
    };
  }
  const boundaryTag = selectPseudoXmlBoundaryTag(PRIOR_USER_MESSAGE_TAG, text);
  return {
    ...message,
    content: [
      { type: "text", text: `<${boundaryTag}>\n` },
      ...message.content,
      { type: "text", text: `\n</${boundaryTag}>` },
    ],
  };
}

function isContextLengthError(error: unknown): boolean {
  return isModelCallError(error) && error.code === "context_length";
}

/**
 * Run the no-tools summarization call over `[working..., summaryInstruction]`.
 *
 * Proactively trims tool outputs to fit the real model window up front (Codex remote parity), so a
 * turn that overshot the window between threshold checks still summarizes the largest fitting slice.
 * Because that ceiling is the real window (not the lower auto-compact trigger), a normal compaction
 * trims nothing and stays lossless. The reactive retry below is a thin net for the residual case
 * where the estimator under-charged and the provider still rejects the request for context length:
 * shrink newest-first and retry. Returns the summary text, or null when summarization fails for any
 * other reason, yields nothing, or there is no tool output left to reclaim.
 */
async function summarizeCompactionInput(
  ctx: PromptContext,
  messages: Message[],
  contextWindowTokens: number | undefined,
): Promise<string | null> {
  let attemptMessages = contextWindowTokens
    ? truncateToolOutputsToFit(
        messages,
        Math.floor(contextWindowTokens * COMPACTION_REQUEST_INPUT_RATIO),
      )
    : messages;
  for (let attempt = 0; attempt < COMPACTION_SUMMARY_FIT_ATTEMPTS; attempt += 1) {
    try {
      // Keep the runtime's tools so the summarization request reuses the exact
      // [system][tools][working...] prefix of the surrounding loop turns. Dropping them (empty
      // `tools`) omits the tool-definitions block, busting the provider prompt-cache prefix and
      // forcing a full re-encode of the large working set.
      const summaryRuntime = ctx.fork({ toolCallLoopMiddlewares: [] });
      const turn = await executeTurn(attemptMessages, {
        runtime: summaryRuntime,
        toolChoice: "none",
        channel: COMPACTION_STREAM_CHANNEL,
      });
      const summaryText = messageContentToText(turn.message.content).trim();
      return summaryText.length === 0 ? null : summaryText;
    } catch (error) {
      if (isAbortError(error)) {
        // A user abort must surface as an interrupt, never as a "summarization failed" null.
        throw error;
      }
      if (!isContextLengthError(error)) {
        return null;
      }
      const before = estimateMessagesTokens(attemptMessages);
      const shrunk = truncateToolOutputsToFit(
        attemptMessages,
        Math.floor(before * COMPACTION_SUMMARY_SHRINK_RATIO),
      );
      if (estimateMessagesTokens(shrunk) >= before) {
        // No tool output left to stub - retrying the same oversized request is futile.
        return null;
      }
      attemptMessages = shrunk;
    }
  }
  return null;
}

/**
 * Drop equipped prefix messages from a persistable history. The compaction replacement carries
 * system + instruction so the live loop keeps its role/rules, but the caller re-adds them from
 * `equipSystem` / `equipInstruction` on the next run.
 */
export function withoutEquippedPrefix(messages: Message[]): Message[] {
  return messages.filter((message) => message.role !== "system" && !isInstructionMessage(message));
}

export async function runContextCompaction(
  ctx: PromptContext,
  working: Message[],
  config: PromptChatCompactionConfig,
): Promise<{ history: Message[]; keptUserMessages: number } | null> {
  const summaryText = await summarizeCompactionInput(
    ctx,
    [...working, { role: "user", content: config.summaryInstruction }],
    config.contextWindowTokens,
  );
  if (summaryText === null) {
    return null;
  }

  const prefix = config.summaryPrefix ?? DEFAULT_SUMMARY_PREFIX;
  // Exclude prior rounds' bridge message (notice + summary) from the recent-user selection: it is
  // a user-role message, so without this filter each round re-collects it as the "most recent user
  // turn" and the summaries stack.
  const keptUsers = selectRecentUserMessages(
    working.filter(
      (message) =>
        !isInstructionMessage(message) &&
        !(
          message.role === "user" &&
          messageContentToText(message.content).startsWith(COMPACTION_NOTICE_PREFIX)
        ),
    ),
    config.keepRecentUserTokens ?? DEFAULT_KEEP_RECENT_USER_TOKENS,
  );
  // Re-inject the equipped prefix: the working set it summarizes away carries system + instruction,
  // and `selectRecentUserMessages` keeps only user task turns, so without this the agent loses its
  // role/output/stop rules after the first compaction. The prefix is stripped back out of the
  // persisted `compactedHistory` (the caller re-adds it), so only the live loop sees it here.
  //
  // Ordering is Codex parity (`build_compacted_history`): kept user turns verbatim FIRST, then the
  // summary as the final user-role bridge message. Placing kept users after the summary makes them
  // read as consecutive unanswered questions (their assistant replies were summarized away), so the
  // model re-answers already-handled turns. With the summary last, the kept turns read as historical
  // inputs and the model continues from the checkpoint.
  const history: Message[] = [
    ...ctx.system,
    ...ctx.instruction,
    ...keptUsers.map(wrapPriorUserMessage),
    {
      role: "user",
      content: `${COMPACTION_NOTICE}\n\n${renderPseudoXmlElement(
        COMPACTION_SUMMARY_TAG,
        `${prefix}\n${summaryText}`,
      )}`,
    },
  ];
  return { history, keptUserMessages: keptUsers.length };
}
