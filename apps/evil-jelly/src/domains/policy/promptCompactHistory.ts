import type { Message } from "@rejelly/core";
import { createAgentPolicy, normalizeMessages } from "@rejelly/core/policy";
import { materializeMessageHistory } from "../../shared/blobs/sessionBlobStore";
import {
  type PromptChatCompactionConfig,
  runContextCompaction,
  withoutEquippedPrefix,
} from "./compaction";

export const COMPACT_HISTORY_POLICY_ID = "evil-jelly-compact-history";

export interface PromptCompactHistoryOptions {
  /** Conversation to summarize (persisted history; the runtime supplies the equipped prefix). */
  message: Message[];
  compaction: PromptChatCompactionConfig;
  sessionBlobRoot?: string;
}

/**
 * Manual (/compress) entry into the same summarization path as mid-loop auto-compaction
 * (`runContextCompaction`): one no-tools side turn over the given history, with no threshold gate.
 * Returns the replacement history without the equipped prefix (callers re-add system/instruction
 * on the next run), or null when summarization yields nothing usable.
 */
export const promptCompactHistory = createAgentPolicy({
  policyId: COMPACT_HISTORY_POLICY_ID,
  handler: async (ctx, options?: PromptCompactHistoryOptions): Promise<Message[] | null> => {
    if (!options) {
      throw new Error("promptCompactHistory requires a history and a compaction config.");
    }
    const history = await materializeMessageHistory(
      options.message,
      options.sessionBlobRoot ? { blobRoot: options.sessionBlobRoot } : {},
    );
    const runtime = ctx.fork({ messages: normalizeMessages([...ctx.messages, ...history]) });
    const result = await runContextCompaction(runtime, runtime.messages, options.compaction);
    return result ? withoutEquippedPrefix(result.history) : null;
  },
}) as (options: PromptCompactHistoryOptions) => Promise<Message[] | null>;
