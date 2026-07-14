import { describe, expect, it } from "vitest";
import { InvalidMessageHistoryError } from "../domain/errors";
import type { Message } from "../domain/model";
import { mergeConsecutiveSameRoleMessages, normalizeMessages } from "../engine/message-builder";

describe("normalizeMessages", () => {
  it("keeps consecutive same-role messages separate (flattening is adapter-side)", () => {
    const messages: Message[] = [
      { role: "system", content: "sys-1" },
      { role: "system", content: "sys-2" },
      { role: "user", content: "user-1" },
      {
        role: "user",
        content: [
          { type: "image", image: { url: "https://example.com/a.png" } },
          { type: "text", text: "user-2" },
        ],
      },
    ];

    const result = normalizeMessages(messages);

    expect(result).toEqual([
      { role: "system", content: "sys-1" },
      { role: "system", content: "sys-2" },
      { role: "user", content: [{ type: "text", text: "user-1" }] },
      {
        role: "user",
        content: [
          { type: "image", image: { url: "https://example.com/a.png" } },
          { type: "text", text: "user-2" },
        ],
      },
    ]);
  });

  it("keeps tool messages matched to assistant tool calls", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call-1", name: "search", arguments: "{}" },
          { id: "call-2", name: "fetch", arguments: "{}" },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "part-1" },
      { role: "tool", tool_call_id: "call-2", content: "other" },
    ];

    const result = normalizeMessages(messages);

    expect(result).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call-1", name: "search", arguments: "{}" },
          { id: "call-2", name: "fetch", arguments: "{}" },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "part-1" },
      { role: "tool", tool_call_id: "call-2", content: "other" },
    ]);
  });

  it("throws for consecutive assistant messages", () => {
    expect(() =>
      normalizeMessages([
        { role: "assistant", content: "assistant-1" },
        { role: "assistant", content: "assistant-2" },
      ]),
    ).toThrow(InvalidMessageHistoryError);
  });

  it("throws when a tool message has no matching assistant tool call", () => {
    expect(() =>
      normalizeMessages([{ role: "tool", tool_call_id: "call-1", content: "orphan" }]),
    ).toThrow(/unknown tool_call_id: call-1/);
  });

  it("throws when assistant tool calls are missing tool results", () => {
    expect(() =>
      normalizeMessages([
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-1", name: "search", arguments: "{}" }],
        },
        { role: "user", content: "next question" },
      ]),
    ).toThrow(/missing tool result for tool_call_id\(s\): call-1/);
  });
});

describe("mergeConsecutiveSameRoleMessages", () => {
  it("merges consecutive system and user messages", () => {
    const messages: Message[] = [
      { role: "system", content: "sys-1" },
      { role: "system", content: "sys-2" },
      { role: "user", content: "user-1" },
      {
        role: "user",
        content: [
          { type: "image", image: { url: "https://example.com/a.png" } },
          { type: "text", text: "user-2" },
        ],
      },
    ];

    const result = mergeConsecutiveSameRoleMessages(messages);

    expect(result).toEqual([
      { role: "system", content: "sys-1\n\nsys-2" },
      {
        role: "user",
        content: [
          { type: "text", text: "user-1" },
          { type: "text", text: "\n\n" },
          { type: "image", image: { url: "https://example.com/a.png" } },
          { type: "text", text: "user-2" },
        ],
      },
    ]);
  });

  it("does not merge messages carrying extra metadata", () => {
    const messages: Message[] = [
      { role: "user", content: "plain" },
      { role: "user", content: "instruction", extra: { kind: "instruction" } },
    ];

    expect(mergeConsecutiveSameRoleMessages(messages)).toEqual(messages);
  });

  it("does not mutate its input", () => {
    const first: Message = { role: "user", content: "user-1" };
    const messages: Message[] = [first, { role: "user", content: "user-2" }];

    mergeConsecutiveSameRoleMessages(messages);

    expect(first).toEqual({ role: "user", content: "user-1" });
  });
});
