import type { JsonSchema, Message } from "@rejelly/core";
import { isAbortError, ToolLoopExceededError } from "@rejelly/core";
import {
  executeTools,
  executeValidatedLoopTurn,
  type LoopTurnResult,
  type OutputParser,
  type PromptContext,
} from "@rejelly/core/policy";
import { appendMessageContentSuffix } from "../../shared/lib/message";
import { estimateMessagesTokens } from "../../shared/lib/tokens";
import type { SessionMessageSink } from "../../shared/session/recorderPort";
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
  pendingUserMessages?: () => Message[] | Promise<Message[]>;
  compaction?: PromptChatCompactionConfig;
  sessionRecorder?: SessionMessageSink;
  turnId?: string;
}

class CompactionController {
  #baseMessages: Message[];
  #compacted = false;
  #rounds = 0;

  constructor(
    private readonly ctx: PromptContext,
    private readonly config: PromptChatCompactionConfig | undefined,
    baseMessages: Message[],
    private readonly recorder?: SessionMessageSink,
    private readonly turnId?: string,
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

    const startedAt = Date.now();
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
    const info = {
      round: this.#rounds,
      beforeTokens,
      afterTokens: estimateMessagesTokens(compactionResult.history),
      keptUserMessages: compactionResult.keptUserMessages,
    };
    compaction.onCompacted?.(info);
    if (this.recorder && this.turnId) {
      await this.recorder.recordCompaction({
        trigger: "auto",
        activeTurnId: this.turnId,
        replacementHistory: withoutEquippedPrefix(compactionResult.history),
        beforeMessageCount: working.length,
        beforeTokens,
        afterTokens: info.afterTokens,
        keptUserMessages: info.keptUserMessages,
        durationMs: Date.now() - startedAt,
      });
    }
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
  const compaction = new CompactionController(
    ctx,
    snapshot.compaction,
    ctx.messages,
    snapshot.sessionRecorder,
    snapshot.turnId,
  );

  let step = 0;

  try {
    while (step < maxTurnSteps) {
      const pendingMessages = (await snapshot.pendingUserMessages?.()) ?? [];
      for (const message of pendingMessages) {
        deltaMessages.push(message);
        if (snapshot.sessionRecorder && snapshot.turnId) {
          await snapshot.sessionRecorder.recordMessage(
            snapshot.turnId,
            { kind: "user_input", inputKind: "steer" },
            message,
          );
        }
      }

      await compaction.maybeCompact(deltaMessages);

      const result: LoopTurnResult = await executeValidatedLoopTurn({
        runtime: ctx.fork({ messages: compaction.messages(deltaMessages) }),
        jsonSchema: snapshot.jsonSchema,
        parser: snapshot.parser,
        maxRetries: ctx.maxRetries,
      });

      deltaMessages.push(...result.deltaMessages);
      if (snapshot.sessionRecorder && snapshot.turnId) {
        await snapshot.sessionRecorder.recordMessages(
          snapshot.turnId,
          result.deltaMessages.map((message) => ({
            source:
              message.role === "assistant"
                ? ({ kind: "model" } as const)
                : ({ kind: "agent_runtime" } as const),
            message,
          })),
        );
      }

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
      if (snapshot.sessionRecorder && snapshot.turnId) {
        await snapshot.sessionRecorder.recordMessages(
          snapshot.turnId,
          toolOutputs.map((message) => ({ source: { kind: "tool" } as const, message })),
        );
      }
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
