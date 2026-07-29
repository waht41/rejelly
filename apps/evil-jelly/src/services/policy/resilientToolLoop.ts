import type { JsonSchema, Message } from "@rejelly/core";
import { isAbortError, ToolLoopExceededError } from "@rejelly/core";
import {
  executeTools,
  executeValidatedLoopTurn,
  type LoopTurnResult,
  type OutputParser,
  type PromptContext,
} from "@rejelly/core/policy";
import type { LineInputValue } from "../../shared/AgentShared";
import { buildUserMessage } from "../../shared/attachments/messageContent";
import { appendMessageContentSuffix } from "../../shared/lib/message";
import { estimateMessagesTokens } from "../../shared/lib/tokens";
import {
  DEFAULT_COMPACTION_MAX_ROUNDS,
  DEFAULT_WARN_RATIO,
  type PromptChatCompactionConfig,
  runContextCompaction,
  withoutEquippedPrefix,
} from "./compaction";
import { sanitizeInterruptedDelta } from "./interruptedDelta";
import type {
  PromptChatResilientResult,
  ResilientChatAbortResult,
  ResilientChatPolicyResult,
} from "./promptChatResilient";

export interface ToolCallLoopPolicySnapshot {
  jsonSchema?: JsonSchema;
  parser?: OutputParser;
  pendingUserInputs?: () => LineInputValue[] | Promise<LineInputValue[]>;
  compaction?: PromptChatCompactionConfig;
}

class CompactionController {
  #baseMessages: Message[];
  #compacted = false;
  #rounds = 0;

  constructor(
    private readonly ctx: PromptContext,
    private readonly config: PromptChatCompactionConfig | undefined,
    baseMessages: Message[],
  ) {
    this.#baseMessages = baseMessages;
  }

  messages(deltaMessages: Message[]): Message[] {
    return [...this.#baseMessages, ...deltaMessages];
  }

  compactedHistory(deltaMessages: Message[]): Message[] | undefined {
    if (!this.#compacted) {
      return undefined;
    }
    return withoutEquippedPrefix(this.messages(deltaMessages));
  }

  async maybeCompact(deltaMessages: Message[]): Promise<void> {
    const compaction = this.config;
    if (!compaction || this.#rounds >= (compaction.maxRounds ?? DEFAULT_COMPACTION_MAX_ROUNDS)) {
      return;
    }

    // #baseMessages includes the system prompt (seeded by the policy pre-compaction, re-injected by
    // runContextCompaction after), so this is the full occupancy - no separate system term to add.
    const working = this.messages(deltaMessages);
    const beforeTokens = estimateMessagesTokens(working);
    if (beforeTokens < compaction.thresholdTokens || deltaMessages.length <= 2) {
      return;
    }

    const compactionResult = await runContextCompaction(this.ctx, working, compaction);
    if (!compactionResult) {
      // Summarization produced nothing usable; stop retrying so we don't burn model turns.
      this.#rounds = compaction.maxRounds ?? DEFAULT_COMPACTION_MAX_ROUNDS;
      return;
    }

    this.#baseMessages = compactionResult.history;
    deltaMessages.length = 0;
    this.#compacted = true;
    this.#rounds += 1;
    compaction.onCompacted?.({
      round: this.#rounds,
      beforeTokens,
      afterTokens: estimateMessagesTokens(compactionResult.history),
      keptUserMessages: compactionResult.keptUserMessages,
    });
  }

  maybeAppendWarnHint(deltaMessages: Message[], toolOutputs: Message[]): void {
    const compaction = this.config;
    if (!compaction?.warnHint || toolOutputs.length === 0) {
      return;
    }

    const occupancy = estimateMessagesTokens(this.messages(deltaMessages));
    const warnAt = compaction.thresholdTokens * (compaction.warnRatio ?? DEFAULT_WARN_RATIO);
    if (occupancy < warnAt || occupancy >= compaction.thresholdTokens) {
      return;
    }

    const lastIndex = deltaMessages.length - 1;
    deltaMessages[lastIndex] = {
      ...deltaMessages[lastIndex],
      content: appendMessageContentSuffix(deltaMessages[lastIndex].content, compaction.warnHint),
    };
  }
}

function buildSuccessResult<T>(
  compaction: CompactionController,
  deltaMessages: Message[],
  data: T,
): ResilientChatPolicyResult<T> {
  const compactedHistory = compaction.compactedHistory(deltaMessages);
  return {
    aborted: false,
    data,
    delta: deltaMessages,
    ...(compactedHistory ? { compactedHistory } : {}),
  };
}

function buildAbortResult(
  compaction: CompactionController,
  sanitizedDelta: Message[],
): ResilientChatAbortResult {
  const compactedHistory = compaction.compactedHistory(sanitizedDelta);
  return {
    aborted: true,
    delta: sanitizedDelta,
    ...(compactedHistory ? { compactedHistory } : {}),
  };
}

export async function runResilientToolCallLoopPolicy<T = unknown>(
  ctx: PromptContext,
  snapshot: ToolCallLoopPolicySnapshot,
): Promise<PromptChatResilientResult<T>> {
  const maxTurnSteps = ctx.maxTurnSteps;
  const deltaMessages: Message[] = [];
  const compaction = new CompactionController(ctx, snapshot.compaction, ctx.messages);

  let step = 0;

  try {
    while (step < maxTurnSteps) {
      const pendingInputs = (await snapshot.pendingUserInputs?.()) ?? [];
      for (const input of pendingInputs) {
        deltaMessages.push(
          await buildUserMessage({
            userInput: input.text,
            attachments: input.attachments,
          }),
        );
      }

      await compaction.maybeCompact(deltaMessages);

      const result: LoopTurnResult = await executeValidatedLoopTurn({
        runtime: ctx.fork({ messages: compaction.messages(deltaMessages) }),
        jsonSchema: snapshot.jsonSchema,
        parser: snapshot.parser,
        maxRetries: ctx.maxRetries,
      });

      deltaMessages.push(...result.deltaMessages);

      if (result.kind === "content") {
        return buildSuccessResult(compaction, deltaMessages, result.data as T);
      }

      if (step >= maxTurnSteps - 1) {
        step++;
        break;
      }

      const toolRuntime = ctx.fork({ messages: compaction.messages(deltaMessages) });
      const toolOutputs = await executeTools(result.calls, { runtime: toolRuntime });
      deltaMessages.push(...toolOutputs);
      step++;

      compaction.maybeAppendWarnHint(deltaMessages, toolOutputs);
    }
  } catch (error) {
    if (isAbortError(error)) {
      ctx.span.setAttribute("aborted", true);
      return buildAbortResult(compaction, sanitizeInterruptedDelta(deltaMessages));
    }
    throw error;
  }

  throw new ToolLoopExceededError(maxTurnSteps, maxTurnSteps);
}
