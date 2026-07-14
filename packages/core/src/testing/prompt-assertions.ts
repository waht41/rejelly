/**
 * Prompt Assertions
 *
 * Utilities for asserting system prompts and instructions sent to the model.
 * Works by inspecting CallRecord messages captured by MockModel.
 */

import { type ContentPart, isInstructionMessage, type Message } from "../core/domain/model";
import type { CallRecord, MockModel } from "./type";

/**
 * Extract text content from a Message's content field
 */
function extractTextContent(content: Message["content"]): string {
  if (content === null) return "";
  if (typeof content === "string") return content;
  return (content as ContentPart[])
    .filter((p) => p.type === "text")
    .map((p) => (p as { type: "text"; text: string }).text)
    .join("");
}

/**
 * Get the merged system prompt text from a call record
 */
function getSystemText(record: CallRecord): string {
  return record.messages
    .filter((m: Message) => m.role === "system")
    .map((m: Message) => extractTextContent(m.content))
    .join("\n\n");
}

/**
 * Get the merged instruction (user message) text from a call record
 */
function getInstructionText(record: CallRecord): string {
  return record.messages
    .filter((m: Message) => isInstructionMessage(m))
    .map((m: Message) => extractTextContent(m.content))
    .join("\n\n");
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Assert that the system prompt sent to the model contains the expected text.
 *
 * @param mock - MockModel instance that recorded calls
 * @param expected - Text or RegExp to match against system prompt
 * @param callIndex - Which call to check (default: 0 = first call)
 *
 * @example
 * const mock = createMockModel()
 * mock.setDefaultResponse({ result: 'ok' })
 * const forked = MyAgent.fork({ model: mock.adapter })
 * await runWith(async () => await forked({ topic: 'AI' }))
 * expectSystemContains(mock, 'You are a helpful assistant')
 */
export function expectSystemContains(
  mock: MockModel,
  expected: string | RegExp,
  callIndex = 0,
): void {
  const record = getCallRecord(mock, callIndex);
  const systemText = getSystemText(record);

  const matched =
    typeof expected === "string" ? systemText.includes(expected) : expected.test(systemText);

  if (!matched) {
    throw new Error(
      `[expectSystemContains] Call #${callIndex}: system prompt does not contain ${typeof expected === "string" ? JSON.stringify(expected) : expected}.\n` +
        `  Actual system prompt: ${truncate(systemText)}`,
    );
  }
}

/**
 * Assert that the instruction (user message) sent to the model contains the expected text.
 *
 * @param mock - MockModel instance that recorded calls
 * @param expected - Text or RegExp to match against instructions
 * @param callIndex - Which call to check (default: 0 = first call)
 *
 * @example
 * const mock = createMockModel()
 * mock.setDefaultResponse({ result: 'ok' })
 * const forked = MyAgent.fork({ model: mock.adapter })
 * await runWith(async () => await forked({ topic: 'AI' }))
 * expectInstructionContains(mock, 'AI')
 */
export function expectInstructionContains(
  mock: MockModel,
  expected: string | RegExp,
  callIndex = 0,
): void {
  const record = getCallRecord(mock, callIndex);
  const instructionText = getInstructionText(record);

  const matched =
    typeof expected === "string"
      ? instructionText.includes(expected)
      : expected.test(instructionText);

  if (!matched) {
    throw new Error(
      `[expectInstructionContains] Call #${callIndex}: instruction does not contain ${typeof expected === "string" ? JSON.stringify(expected) : expected}.\n` +
        `  Actual instruction: ${truncate(instructionText)}`,
    );
  }
}

/**
 * Get a call record from the mock, with helpful error messages
 */
function getCallRecord(mock: MockModel, callIndex: number): CallRecord {
  const calls = mock.calls.all();
  if (calls.length === 0) {
    throw new Error(
      "MockModel has no recorded calls. Did you forget to run the agent with mock.adapter?",
    );
  }
  if (callIndex >= calls.length) {
    throw new Error(
      `MockModel only has ${calls.length} call(s), but callIndex=${callIndex} was requested.`,
    );
  }
  return calls[callIndex];
}
