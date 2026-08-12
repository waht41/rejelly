import { describe, expect, it } from "vitest";
import { attachedImages, imageToken, shiftImageTokens } from "./imageAttachments";

describe("image attachments", () => {
  it("formats and shifts inline image tokens", () => {
    expect(imageToken(2)).toBe("[Image #2]");
    expect(shiftImageTokens("a[Image #1]b[Image #2]", 3)).toBe("a[Image #4]b[Image #5]");
  });

  it("materializes surviving image tokens once in first-seen order", () => {
    expect(attachedImages("[Image #2] [Image #1] [Image #2]", ["one", "two"])).toEqual([
      "two",
      "one",
    ]);
  });
});
