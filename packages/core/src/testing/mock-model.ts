/**
 * Mock Model
 *
 * Provides a configurable mock ModelAdapter for testing.
 */

import type {
  JsonSchema,
  Message,
  MessageContent,
  ModelAdapter,
  ModelStreamOptions,
  StreamEvent,
  TokenUsage,
} from "../core/domain/model";
import type { JsonValue } from "../utils/type";
import type {
  CallRecord,
  CallsAPI,
  MockModel,
  MockResponse,
  MockSequenceStep,
  MockUsage,
  RuleBuilder,
  RuleCondition,
  RuleConfig,
  RulePayload,
} from "./type";

/** Split string into segments of at most chunkSize characters */
function splitStringIntoChunks(str: string, chunkSize: number): string[] {
  if (chunkSize <= 0) {
    throw new Error(`chunkSize must be positive, got ${chunkSize}`);
  }
  const out: string[] = [];
  for (let i = 0; i < str.length; i += chunkSize) {
    out.push(str.slice(i, i + chunkSize));
  }
  return out;
}

// ============ Implementation ============

function buildTokenUsage(usage: MockUsage): TokenUsage {
  return {
    promptTokens: usage.promptTokens ?? 0,
    completionTokens: usage.completionTokens ?? 0,
    totalTokens: usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
    ...(usage.details && Object.keys(usage.details).length > 0 ? { details: usage.details } : {}),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Convert MessageContent to string for rule matching (text parts only; image/video become placeholders) */
function messageContentToText(content: MessageContent): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image") return "[image]";
      if (part.type === "video") return "[video]";
      return "";
    })
    .join("");
}

function extractPayload(messages: Message[], schema?: JsonSchema): RulePayload {
  const userMessages = messages
    .filter((m) => m.role === "user" && m.content !== null)
    .map((m) => messageContentToText(m.content!));

  return {
    messages,
    schema,
    lastUserMessage: userMessages[userMessages.length - 1],
    userMessages,
  };
}

function matchCondition(condition: RuleCondition, payload: RulePayload): boolean {
  if (typeof condition === "function") {
    return condition(payload);
  }

  if ("input" in condition) {
    const { input } = condition;
    const text = payload.userMessages.join(" ");
    return typeof input === "string" ? text.includes(input) : input.test(text);
  }

  if ("toolName" in condition) {
    const { toolName } = condition;
    const lastMessage = payload.messages[payload.messages.length - 1];
    // Match tool result message by name field (tool_call_id is a random ID, not the tool name)
    if (lastMessage?.role === "tool" && lastMessage.name === toolName) {
      return true;
    }
    // Also check if the preceding assistant message invoked this tool
    const assistantMessages = payload.messages.filter((m) => m.role === "assistant");
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    if (lastAssistant?.tool_calls?.some((tc) => tc.name === toolName)) {
      return true;
    }
    return payload.userMessages.some((msg) => msg.includes(toolName));
  }

  return false;
}

function responseToString(response: MockResponse): string {
  return typeof response === "string" ? response : JSON.stringify(response);
}

/**
 * Mock Model implementation
 */
class MockModelImpl implements MockModel {
  _rules: RuleConfig[] = [];
  _callRecords: CallRecord[] = [];
  _defaultResponse?: MockResponse;
  _defaultUsage?: MockUsage;
  _adapter: ModelAdapter;
  _sequence: MockSequenceStep[] = [];
  _sequenceUsage?: MockUsage[];
  _sequenceIndex: number = 0;
  _sequenceDelay?: number;
  _defaultDelay?: number;
  _costCalculator?: (usage: TokenUsage) => Record<string, number>;

  constructor() {
    this._adapter = this.createAdapter();
  }

  get adapter(): ModelAdapter {
    return this._adapter;
  }

  private createAdapter(): ModelAdapter {
    const self = this;
    return {
      id: "mock-model",
      stream(messages: Message[], options?: ModelStreamOptions): AsyncGenerator<StreamEvent> {
        const { schema, signal } = options ?? {};

        if (signal?.aborted) {
          throw new Error("Aborted");
        }

        // Record call synchronously before returning generator
        const record: CallRecord = {
          messages: [...messages],
          schema,
          timestamp: Date.now(),
          index: self._callRecords.length,
        };
        self._callRecords.push(record);

        return (async function* (): AsyncGenerator<StreamEvent> {
          const payload = extractPayload(messages, schema);

          // Priority 1: Check sequence (if available)
          if (self._sequence.length > 0 && self._sequenceIndex < self._sequence.length) {
            if (self._sequenceDelay) {
              await delay(self._sequenceDelay);
            }
            const sequenceIndex = self._sequenceIndex;
            const step = self._sequence[sequenceIndex];
            const usageFromLegacySequence = self._sequenceUsage?.[sequenceIndex];
            self._sequenceIndex++;

            if (step.delay) {
              await delay(step.delay);
            }

            switch (step.type) {
              case "error":
                throw step.error;

              case "stream": {
                const chunksToEmit = step.chunks;
                for (let i = 0; i < chunksToEmit.length; i++) {
                  yield { type: "text", content: chunksToEmit[i] };
                  if (step.chunkInterval && i < chunksToEmit.length - 1) {
                    await delay(step.chunkInterval);
                  }
                }
                break;
              }

              case "stream_object": {
                const chunksToEmit = splitStringIntoChunks(
                  responseToString(step.content),
                  step.chunkSize ?? 1,
                );
                for (let i = 0; i < chunksToEmit.length; i++) {
                  yield { type: "text", content: chunksToEmit[i] };
                  if (step.chunkInterval && i < chunksToEmit.length - 1) {
                    await delay(step.chunkInterval);
                  }
                }
                break;
              }

              case "tool_calls":
                for (let i = 0; i < step.calls.length; i++) {
                  const tc = step.calls[i];
                  yield {
                    type: "tool_call",
                    toolCall: {
                      index: i,
                      id: tc.id,
                      name: tc.name,
                      arguments: JSON.stringify(tc.arguments),
                      ...(tc.extra && Object.keys(tc.extra).length > 0 ? { extra: tc.extra } : {}),
                    },
                  };
                }
                break;
              case "custom": {
                const customResult = await step.handler(payload);
                yield { type: "text", content: responseToString(customResult) };
                break;
              }
              case "text":
                yield { type: "text", content: step.content };
                break;
              case "json": {
                const responseText = responseToString(step.content);
                yield { type: "text", content: responseText };
                break;
              }
            }

            if (step.extra && Object.keys(step.extra).length > 0) {
              yield { type: "extra", extra: step.extra };
            }

            const finalUsage = step.usage ?? usageFromLegacySequence;
            if (finalUsage) {
              yield { type: "usage", usage: buildTokenUsage(finalUsage) };
            }
            return;
          }

          // Priority 2: Find matching rule
          let matchedRule: RuleConfig | undefined;
          for (const rule of self._rules) {
            if (matchCondition(rule.condition, payload)) {
              matchedRule = rule;
              break;
            }
          }

          // Priority 3: Use default response
          if (!matchedRule) {
            if (self._defaultResponse !== undefined) {
              if (self._defaultDelay) {
                await delay(self._defaultDelay);
              }
              const text = responseToString(self._defaultResponse);
              yield { type: "text", content: text };
              // Yield usage if configured
              if (self._defaultUsage) {
                yield { type: "usage", usage: buildTokenUsage(self._defaultUsage) };
              }
              return;
            }
            throw new Error(
              "No matching rule found. Use mock.when(...), mock.sequence(...), or mock.setDefaultResponse(...).",
            );
          }

          // Handle delay
          if (matchedRule.delay) {
            await delay(matchedRule.delay);
          }

          // Handle response types
          switch (matchedRule.responseType) {
            case "throw":
              throw matchedRule.error ?? new Error("Mock error");

            case "stream": {
              const chunksToEmit =
                matchedRule.streamObject != null
                  ? splitStringIntoChunks(
                      responseToString(matchedRule.streamObject),
                      matchedRule.streamChunkSize ?? 1,
                    )
                  : (matchedRule.chunks ?? []);
              for (let i = 0; i < chunksToEmit.length; i++) {
                yield { type: "text", content: chunksToEmit[i] };
                if (matchedRule.chunkInterval && i < chunksToEmit.length - 1) {
                  await delay(matchedRule.chunkInterval);
                }
              }
              break;
            }

            case "tool_call":
              for (let i = 0; i < (matchedRule.toolCalls ?? []).length; i++) {
                const tc = matchedRule.toolCalls![i];
                yield {
                  type: "tool_call",
                  toolCall: {
                    index: i,
                    id: tc.id,
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                    ...(tc.extra && Object.keys(tc.extra).length > 0 ? { extra: tc.extra } : {}),
                  },
                };
              }
              break;
            case "custom": {
              const customResult = await matchedRule.customFn!(payload);
              yield { type: "text", content: responseToString(customResult) };
              break;
            }
            default: {
              const responseText = responseToString(matchedRule.response ?? "");
              yield { type: "text", content: responseText };
              break;
            }
          }

          // Yield message-level extra metadata if configured.
          if (matchedRule.extra && Object.keys(matchedRule.extra).length > 0) {
            yield { type: "extra", extra: matchedRule.extra };
          }

          // Yield usage if configured
          if (matchedRule.usage) {
            yield { type: "usage", usage: buildTokenUsage(matchedRule.usage) };
          }
        })();
      },
      calculateCost: (usage: TokenUsage): Record<string, number> => {
        if (self._costCalculator) {
          return self._costCalculator(usage);
        }
        // Default: micro_usd per legacy formula ($0.001 per 1000 tokens)
        const usd = (usage.totalTokens * 0.001) / 1000;
        const microUsd = Math.round(usd * 1_000_000);
        return microUsd === 0 ? {} : { micro_usd: microUsd };
      },
    };
  }

  when(condition: RuleCondition): RuleBuilder {
    const rule: RuleConfig = {
      condition,
      responseType: "return",
    };
    this._rules.push(rule);

    const builder: RuleBuilder = {
      thenReturn: (response) => {
        rule.responseType = "return";
        rule.response = response;
        return builder;
      },
      thenStream: (chunksOrObject, chunkSize) => {
        rule.responseType = "stream";
        const isStringArray =
          Array.isArray(chunksOrObject) && chunksOrObject.every((x) => typeof x === "string");
        if (isStringArray) {
          rule.chunks = chunksOrObject as string[];
        } else {
          rule.streamObject = chunksOrObject as JsonValue;
          rule.streamChunkSize = chunkSize ?? 1;
        }
        return builder;
      },
      thenCallTools: (toolCalls) => {
        rule.responseType = "tool_call";
        rule.toolCalls = toolCalls;
        return builder;
      },
      thenThrow: (error) => {
        rule.responseType = "throw";
        rule.error = error;
        return builder;
      },
      thenDo: (fn) => {
        rule.responseType = "custom";
        rule.customFn = fn;
        return builder;
      },
      withDelay: (ms) => {
        rule.delay = ms;
        return builder;
      },
      withChunkInterval: (ms) => {
        rule.chunkInterval = ms;
        return builder;
      },
      withExtra: (extra) => {
        rule.extra = extra;
        return builder;
      },
      withUsage: (usage) => {
        rule.usage = usage;
        return builder;
      },
    };

    return builder;
  }

  calls: CallsAPI = {
    all: () => [...this._callRecords],
    count: () => this._callRecords.length,
    first: () => this._callRecords[0],
    last: () => this._callRecords[this._callRecords.length - 1],
    clear: () => {
      this._callRecords = [];
    },
  };

  reset(): void {
    this._rules = [];
    this._callRecords = [];
    this._defaultResponse = undefined;
    this._defaultUsage = undefined;
    this._defaultDelay = undefined;
    this._sequence = [];
    this._sequenceUsage = undefined;
    this._sequenceIndex = 0;
    this._sequenceDelay = undefined;
    this._costCalculator = undefined;
  }

  sequence(steps: MockSequenceStep[]): void {
    this._sequence = [...steps];
    this._sequenceIndex = 0;
  }

  setDefaultResponse(response: MockResponse): void {
    this._defaultResponse = response;
  }

  setDefaultUsage(usage: MockUsage): void {
    this._defaultUsage = usage;
  }

  setSequenceUsage(usage: MockUsage[]): void {
    this._sequenceUsage = [...usage];
  }

  setSequenceDelay(ms: number): void {
    this._sequenceDelay = ms;
  }

  setDefaultDelay(ms: number): void {
    this._defaultDelay = ms;
  }

  setCostCalculator(calculator: (usage: TokenUsage) => Record<string, number>): void {
    this._costCalculator = calculator;
  }
}

// ============ Factory Functions ============

/**
 * Create mock model
 *
 * @returns MockModel instance
 *
 * @example
 * const mock = createMockModel();
 *
 * mock.when({ input: 'hello' }).thenReturn({ response: 'hi' });
 * mock.when(() => true).thenReturn({ fallback: true });
 *
 * const agent = createAgent({
 *   id: 'test',
 *   model: mock.adapter,
 *   handler: async () => { ... }
 * });
 */
export function createMockModel(): MockModel {
  return new MockModelImpl();
}
