import type { Message, ToolDefinition } from "@rejelly/core";
import {
  createAgentPolicy,
  createJsonOutputParser,
  normalizeMessages,
  transferJsonSchema,
} from "@rejelly/core/policy";
import type { z } from "zod";
import type { SessionMessageSink } from "../../shared/session/recorderPort";
import type { PromptChatCompactionConfig, PromptTokenUsageReader } from "./compaction";
import {
  runResilientToolCallLoopPolicy,
  type ToolCallLoopPolicySnapshot,
} from "./resilientToolLoop";

export type { PromptChatCompactionConfig } from "./compaction";

export interface ResilientChatPolicyResult<T = string> {
  aborted: false;
  data: T;
  delta: Message[];
  /**
   * Present only when mid-loop auto-compaction ran: the full compacted conversation (initial
   * verbatim user turns + summary + post-compaction work). Callers must REPLACE their persisted
   * history with this instead of appending `delta`, otherwise the pre-compaction bulk re-inflates.
   */
  compactedHistory?: Message[];
}

export interface ResilientChatAbortResult {
  aborted: true;
  delta: Message[];
  compactedHistory?: Message[];
}

export type PromptChatResilientResult<T = string> =
  | ResilientChatPolicyResult<T>
  | ResilientChatAbortResult;

export const RESILIENT_CHAT_POLICY_ID = "evil-jelly-resilient-chat";

export type PromptChatResilientMessage = Message | Message[];

export interface PromptChatResilientOptions<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  message?: PromptChatResilientMessage;
  schema?: TSchema;
  pendingUserMessages?: () => Message[] | Promise<Message[]>;
  toolsForDispatch?: (
    baseTools: readonly ToolDefinition[],
  ) => readonly ToolDefinition[] | Promise<readonly ToolDefinition[]>;
  compaction?: PromptChatCompactionConfig;
  /** Provider prompt count associated with a prefix of `message`, recovered from session replay. */
  initialTokenAnchor?: { promptTokens: number; messageCount: number };
  /** Evil-owned per-model-call usage observer; avoids widening Core's policy result API. */
  promptTokenUsage?: PromptTokenUsageReader;
  sessionRecorder?: SessionMessageSink;
  turnId?: string;
}

type PromptChatResilientStringOptions = Omit<PromptChatResilientOptions, "schema">;
type PromptChatResilientSchemaOptions<TSchema extends z.ZodTypeAny> = Omit<
  PromptChatResilientOptions<TSchema>,
  "schema"
> & {
  schema: TSchema;
};

function normalizePromptChatMessages(message: PromptChatResilientMessage | undefined): Message[] {
  return message === undefined ? [] : Array.isArray(message) ? message : [message];
}

export const promptChatResilient = createAgentPolicy({
  policyId: RESILIENT_CHAT_POLICY_ID,
  handler: async (
    ctx,
    options?: PromptChatResilientOptions,
  ): Promise<PromptChatResilientResult<unknown>> => {
    const customMessages = normalizePromptChatMessages(options?.message);
    const jsonSchema = options?.schema ? transferJsonSchema(options.schema) : undefined;

    if (jsonSchema) {
      ctx.span.setAttribute("schema", jsonSchema);
    }

    const runtime = ctx.fork({
      messages: normalizeMessages([...ctx.messages, ...customMessages]),
    });
    const equippedMessageCount = runtime.messages.length - customMessages.length;
    const initialTokenAnchor = options?.initialTokenAnchor;
    const snapshot: ToolCallLoopPolicySnapshot = {
      jsonSchema,
      parser: options?.schema ? createJsonOutputParser(options.schema) : undefined,
      pendingUserMessages: options?.pendingUserMessages,
      toolsForDispatch: options?.toolsForDispatch,
      compaction: options?.compaction,
      ...(initialTokenAnchor &&
      initialTokenAnchor.promptTokens > 0 &&
      Number.isInteger(initialTokenAnchor.messageCount) &&
      initialTokenAnchor.messageCount >= 0 &&
      initialTokenAnchor.messageCount <= customMessages.length
        ? {
            initialTokenAnchor: {
              promptTokens: initialTokenAnchor.promptTokens,
              messages: runtime.messages.slice(
                0,
                equippedMessageCount + initialTokenAnchor.messageCount,
              ),
            },
          }
        : {}),
      promptTokenUsage: options?.promptTokenUsage,
      sessionRecorder: options?.sessionRecorder,
      turnId: options?.turnId,
    };

    return await runResilientToolCallLoopPolicy(runtime, snapshot);
  },
}) as {
  (): Promise<PromptChatResilientResult<string>>;
  (options: PromptChatResilientStringOptions): Promise<PromptChatResilientResult<string>>;
  <TSchema extends z.ZodTypeAny>(
    options: PromptChatResilientSchemaOptions<TSchema>,
  ): Promise<PromptChatResilientResult<z.infer<TSchema>>>;
};
