import type { z } from "zod";
import type { Message } from "../domain/model";
import { normalizeMessages } from "../engine/message-builder";
import { createJsonOutputParser } from "../engine/parse";
import { createAgentPolicy, type PromptContext } from "./prompt";
import { runToolCallLoopPolicy, transferJsonSchema } from "./tool-call-loop-policy";

export interface ChatPolicyResult<T = string> {
  data: T;
  delta: Message[];
}

export const CHAT_POLICY_ID = "standard-chat";

export type PromptChatMessage = Message | Message[];

export interface PromptChatOptions<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  message?: PromptChatMessage;
  schema?: TSchema;
}

function normalizePromptChatMessages(message: PromptChatMessage | undefined): Message[] {
  return message === undefined ? [] : Array.isArray(message) ? message : [message];
}

export const promptChat = createAgentPolicy({
  policyId: CHAT_POLICY_ID,
  handler: async (
    ctx: PromptContext,
    options?: PromptChatOptions,
  ): Promise<ChatPolicyResult<unknown>> => {
    const customMessages = normalizePromptChatMessages(options?.message);
    const jsonSchema = options?.schema ? transferJsonSchema(options.schema) : undefined;

    if (jsonSchema) {
      ctx.span.setAttribute("schema", jsonSchema);
    }

    const runtime = ctx.fork({
      messages: normalizeMessages([...ctx.messages, ...customMessages]),
    });

    return await runToolCallLoopPolicy(runtime, {
      jsonSchema,
      parser: options?.schema ? createJsonOutputParser(options.schema) : undefined,
    });
  },
}) as {
  (): Promise<ChatPolicyResult<string>>;
  (options: { message?: PromptChatMessage }): Promise<ChatPolicyResult<string>>;
  <T extends z.ZodTypeAny>(options: {
    message?: PromptChatMessage;
    schema: T;
  }): Promise<ChatPolicyResult<z.infer<T>>>;
};
