import type { Message } from "@rejelly/core";
import { normalizeMessages, REJELLY_INSTRUCTION_MESSAGE_KIND } from "@rejelly/core/policy";
import { describe, expect, it } from "vitest";
import { estimateMessagesTokens } from "../../shared/lib/tokens";
import {
  sanitizeInterruptedDelta,
  selectRecentUserMessages,
  truncateToolOutputsToFit,
} from "./promptChatResilient";

describe("sanitizeInterruptedDelta", () => {
  it("fills missing tool outputs for interrupted tool calls", () => {
    const delta: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            name: "read_file",
            arguments: '{"path":"README.md"}',
          },
        ],
      },
    ];

    const sanitized = sanitizeInterruptedDelta(delta);

    expect(() => normalizeMessages(sanitized)).not.toThrow();
    expect(sanitized).toEqual([
      delta[0],
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "[Tool execution interrupted by user]",
      },
    ]);
  });

  it("preserves completed tool outputs", () => {
    const delta: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            name: "read_file",
            arguments: '{"path":"README.md"}',
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "done",
      },
    ];

    expect(sanitizeInterruptedDelta(delta)).toEqual(normalizeMessages(delta));
  });
});

describe("selectRecentUserMessages", () => {
  const user = (content: string): Message => ({ role: "user", content });

  it("keeps only the most recent user turns within budget, in original order", () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      user("first task"),
      { role: "assistant", content: "working" },
      { role: "tool", tool_call_id: "c1", content: "big tool output" },
      user("second task"),
      user("third task"),
    ];

    // Each short user string estimates well under 100 tokens, so all three fit.
    expect(selectRecentUserMessages(messages, 100)).toEqual([
      user("first task"),
      user("second task"),
      user("third task"),
    ]);
  });

  it("drops older user turns once the token budget is exhausted (most-recent-first)", () => {
    const messages: Message[] = [user("aaaa aaaa aaaa aaaa"), user("bbbb"), user("cccc")];

    // Budget only large enough for the last two short turns; the oldest is dropped.
    const kept = selectRecentUserMessages(messages, 3);
    expect(kept).toEqual([user("bbbb"), user("cccc")]);
  });

  it("always keeps the single most recent user turn even when it exceeds the budget", () => {
    const messages: Message[] = [
      user("old"),
      user("this current task is very long and over budget"),
    ];

    expect(selectRecentUserMessages(messages, 1)).toEqual([
      user("this current task is very long and over budget"),
    ]);
  });

  it("returns nothing when there are no user turns", () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "hi" },
    ];

    expect(selectRecentUserMessages(messages, 100)).toEqual([]);
  });

  it("does not treat equipped instruction messages as recent user turns", () => {
    const instruction: Message = {
      role: "user",
      content: "stable instruction",
      extra: { rejelly: { kind: REJELLY_INSTRUCTION_MESSAGE_KIND } },
    };
    const messages: Message[] = [instruction, user("actual task")];

    expect(selectRecentUserMessages(messages, 100)).toEqual([user("actual task")]);
  });
});

describe("truncateToolOutputsToFit", () => {
  const bigOutput = (id: string): Message => ({
    role: "tool",
    tool_call_id: id,
    content: "x".repeat(4000), // ~1000 tokens each
  });

  it("returns the input unchanged when it already fits", () => {
    const messages: Message[] = [
      { role: "user", content: "task" },
      { role: "tool", tool_call_id: "c1", content: "small" },
    ];

    expect(truncateToolOutputsToFit(messages, 10_000)).toBe(messages);
  });

  it("stubs tool outputs newest-first until the estimate fits under the budget", () => {
    const messages: Message[] = [
      { role: "user", content: "task" },
      bigOutput("c1"),
      bigOutput("c2"),
      bigOutput("c3"),
    ];

    // ~3000 tokens of tool output; budget forces stubbing the two most recent, keeping the oldest.
    const fitted = truncateToolOutputsToFit(messages, 1200);

    expect(estimateMessagesTokens(fitted)).toBeLessThanOrEqual(1200);
    expect(fitted[1]).toBe(messages[1]); // oldest tool output preserved (cacheable prefix)
    expect(fitted[2].content).not.toEqual(messages[2].content);
    expect(fitted[3].content).not.toEqual(messages[3].content);
    // Non-tool messages are never touched.
    expect(fitted[0]).toBe(messages[0]);
  });

  it("never truncates non-tool messages even when they exceed the budget", () => {
    const messages: Message[] = [{ role: "user", content: "y".repeat(8000) }];

    // No tool outputs to reclaim: returns the input as-is rather than mangling the user turn.
    expect(truncateToolOutputsToFit(messages, 100)).toEqual(messages);
  });
});
