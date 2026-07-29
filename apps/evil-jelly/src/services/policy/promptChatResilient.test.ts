import type { Message } from "@rejelly/core";
import { normalizeMessages, REJELLY_INSTRUCTION_MESSAGE_KIND } from "@rejelly/core/policy";
import { describe, expect, it } from "vitest";
import {
  estimateMessagesTokens,
  estimateTokens,
  IMAGE_CONTENT_TOKEN_ESTIMATE,
} from "../../shared/lib/tokens";
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

  it("truncates the first older turn that crosses the remaining budget", () => {
    const messages: Message[] = [user("aaaa aaaa aaaa aaaa"), user("bbbb"), user("cccc")];

    // The newest two consume two tokens; Codex-style retention uses the final token for a bounded
    // prefix of the first older turn that crosses the budget.
    const kept = selectRecentUserMessages(messages, 3);
    expect(kept).toEqual([user("aaaa"), user("bbbb"), user("cccc")]);
    expect(estimateMessagesTokens(kept)).toBeLessThanOrEqual(3);
  });

  it("truncates the most recent user turn when it alone exceeds the budget", () => {
    const messages: Message[] = [
      user("old"),
      user("this current task is very long and over budget"),
    ];

    const kept = selectRecentUserMessages(messages, 1);

    expect(kept).toHaveLength(1);
    expect(kept[0].content).not.toBe("this current task is very long and over budget");
    expect(estimateTokens(String(kept[0].content))).toBeLessThanOrEqual(1);
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

  it("replaces file payloads with references while retaining recent image content", () => {
    const message: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text:
            'inspect this\n\n<attached_file path="src/secret.txt" path-scope="workspace">\n' +
            "large private file body\n</attached_file>",
        },
        {
          type: "image",
          image: { url: "data:image/png;base64,very-large-payload", detail: "auto" },
        },
      ],
      extra: {
        rejelly: {
          kind: "user_input",
          display: {
            text: "inspect this",
            attachments: [
              {
                type: "file",
                label: "src/secret.txt",
                action: "read",
                locator: { scope: "workspace", path: "src/secret.txt" },
              },
              {
                type: "image",
                label: "[Image #1]",
                action: "attach",
                locator: { scope: "absolute", path: "C:/Temp/clipboard.png" },
              },
            ],
          },
        },
      },
    };

    const kept = selectRecentUserMessages([message], IMAGE_CONTENT_TOKEN_ESTIMATE + 1000);

    expect(kept).toHaveLength(1);
    const keptText = Array.isArray(kept[0].content)
      ? kept[0].content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
      : String(kept[0].content ?? "");
    expect(keptText).toContain("inspect this");
    expect(keptText).toContain(
      '<attached_file_ref action="read" path="src/secret.txt" path-scope="workspace" />',
    );
    expect(keptText).toContain(
      '<attached_image_ref action="attach" path="C:/Temp/clipboard.png" path-scope="absolute" />',
    );
    expect(keptText).not.toContain("large private file body");
    expect(kept[0].content).toContainEqual({
      type: "image",
      image: { url: "data:image/png;base64,very-large-payload", detail: "auto" },
    });
  });

  it("retains image payloads from legacy multimodal messages without guessing file metadata", () => {
    const kept = selectRecentUserMessages(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this image" },
            {
              type: "image",
              image: { url: "data:image/png;base64,payload", detail: "auto" },
            },
          ],
        },
      ],
      IMAGE_CONTENT_TOKEN_ESTIMATE + 100,
    );

    expect(kept).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "describe this image" },
          {
            type: "image",
            image: { url: "data:image/png;base64,payload", detail: "auto" },
          },
        ],
      },
    ]);
  });

  it("retains image payloads solely according to the token budget", () => {
    const messages: Message[] = Array.from({ length: 6 }, (_, index) => ({
      role: "user",
      content: [
        { type: "text", text: `image ${index}` },
        {
          type: "image",
          image: { url: `data:image/png;base64,payload-${index}`, detail: "auto" },
        },
      ],
    }));
    const imageUrls = (kept: Message[]) =>
      kept.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.flatMap((part) => (part.type === "image" ? [part.image.url] : []))
          : [],
      );

    expect(imageUrls(selectRecentUserMessages(messages, estimateMessagesTokens(messages)))).toEqual(
      Array.from({ length: 6 }, (_, index) => `data:image/png;base64,payload-${index}`),
    );

    const newestFour = messages.slice(-4);
    expect(
      imageUrls(selectRecentUserMessages(messages, estimateMessagesTokens(newestFour))),
    ).toEqual(
      Array.from({ length: 4 }, (_, index) => `data:image/png;base64,payload-${index + 2}`),
    );
  });

  it("uses supplied image dimensions when applying the compaction token budget", () => {
    const message: Message = {
      role: "user",
      content: [
        {
          type: "image",
          image: { url: "data:image/png;base64,not-a-real-header", detail: "auto" },
        },
      ],
      extra: {
        rejelly: {
          imageDimensions: [{ width: 512, height: 512 }],
        },
      },
    };

    expect(selectRecentUserMessages([message], 1024)).toEqual([message]);
  });

  it("preserves user text before image payloads when a message crosses the budget", () => {
    const message: Message = {
      role: "user",
      content: [
        { type: "text", text: "explain what this image means" },
        {
          type: "image",
          image: { url: "data:image/png;base64,payload", detail: "auto" },
        },
      ],
    };
    const textBudget = estimateTokens("explain what this image means");

    const kept = selectRecentUserMessages([message], textBudget);

    expect(kept).toEqual([{ role: "user", content: "explain what this image means" }]);
  });

  it("fills the budget with images only after text and marks omitted images", () => {
    const message: Message = {
      role: "user",
      content: [
        { type: "text", text: "compare these" },
        ...Array.from({ length: 3 }, (_, index) => ({
          type: "image" as const,
          image: {
            url: `data:image/png;base64,payload-${index}`,
            detail: "low" as const,
          },
        })),
      ],
    };
    const expectedText = 'compare these\n\n<images_omitted count="1" reason="token-budget" />';
    const expected: Message = {
      role: "user",
      content: [
        { type: "text", text: expectedText },
        {
          type: "image",
          image: { url: "data:image/png;base64,payload-0", detail: "low" },
        },
        {
          type: "image",
          image: { url: "data:image/png;base64,payload-1", detail: "low" },
        },
      ],
    };
    const budget = estimateMessagesTokens([expected]);

    const kept = selectRecentUserMessages([message], budget);

    expect(kept).toEqual([expected]);
  });
});

describe("image token estimation", () => {
  it("charges every image part instead of treating it as zero-cost", () => {
    const estimated = estimateMessagesTokens([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            image: { url: "data:image/png;base64,payload", detail: "auto" },
          },
        ],
      },
    ]);

    expect(estimated).toBe(estimateTokens("look") + IMAGE_CONTENT_TOKEN_ESTIMATE);
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

  it("can reclaim an image-only tool output using the image estimate", () => {
    const messages: Message[] = [
      { role: "user", content: "inspect the image" },
      {
        role: "tool",
        tool_call_id: "c1",
        content: [
          {
            type: "image",
            image: { url: "data:image/png;base64,payload", detail: "auto" },
          },
        ],
      },
    ];

    const fitted = truncateToolOutputsToFit(messages, 100);

    expect(typeof fitted[1].content).toBe("string");
    expect(fitted[1].content).toContain("Output omitted");
    expect(estimateMessagesTokens(fitted)).toBeLessThanOrEqual(100);
  });
});
