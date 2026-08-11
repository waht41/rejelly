import { describe, expect, it } from "vitest";
import { appendMessageContentSuffix, messageContentToText } from "./content";

describe("message content", () => {
  it("appends text without changing existing non-text parts", () => {
    expect(
      appendMessageContentSuffix(
        [{ type: "image", image: { url: "data:image/png;base64,x" } }],
        "continue",
      ),
    ).toEqual([
      { type: "image", image: { url: "data:image/png;base64,x" } },
      { type: "text", text: "\n\ncontinue" },
    ]);
    expect(appendMessageContentSuffix("answer", "continue")).toBe("answer\n\ncontinue");
    expect(appendMessageContentSuffix(null, "continue")).toBe("continue");
  });

  it("projects only text parts while preserving their positions", () => {
    expect(
      messageContentToText([
        { type: "text", text: "before" },
        { type: "image", image: { url: "data:image/png;base64,x" } },
        { type: "text", text: "after" },
      ]),
    ).toBe("before\n\nafter");
    expect(messageContentToText("plain")).toBe("plain");
    expect(messageContentToText(null)).toBe("");
  });
});
