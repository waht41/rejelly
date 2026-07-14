import { describe, expect, it } from "vitest";
import { wrapAsModelCallError } from "../error";
import { toFunctionResponseObject, toGeminiMessages } from "../utils";

describe("Gemini message conversion", () => {
  it("strips media from the function response and keeps the text", () => {
    expect(
      toFunctionResponseObject([
        { type: "text", text: "Image loaded." },
        { type: "image", image: { url: "data:image/png;base64,AAAA" } },
      ]),
    ).toEqual({ content: "Image loaded." });
  });

  it("uses fallback text when the tool returns media only", () => {
    expect(
      toFunctionResponseObject([{ type: "image", image: { url: "data:image/png;base64,AAAA" } }]),
    ).toEqual({ content: "[Tool returned non-text content; see the following user message.]" });
  });

  it("converts text-only tool content parts into a function response object", () => {
    expect(
      toFunctionResponseObject([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ).toEqual({ content: "first\nsecond" });
  });

  it("splits multimodal tool result into a functionResponse and a follow-up user content", async () => {
    const contents = await toGeminiMessages([
      {
        role: "tool",
        name: "view_image",
        content: [
          { type: "text", text: "Image loaded." },
          { type: "image", image: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ]);

    expect(contents).toEqual([
      {
        role: "function",
        parts: [
          { functionResponse: { name: "view_image", response: { content: "Image loaded." } } },
        ],
      },
      {
        role: "user",
        parts: [
          { text: "Tool result content for view_image:" },
          { inlineData: { mimeType: "image/png", data: "AAAA" } },
        ],
      },
    ]);
  });
});

describe("Gemini error conversion", () => {
  it("normalizes SDK abort-like errors to AbortError", () => {
    expect(() =>
      wrapAsModelCallError(new Error("Request was aborted."), "gemini-2.5-flash"),
    ).toThrowError(expect.objectContaining({ name: "AbortError" }));
  });
});
