import { tool } from "@langchain/core/tools";
import { isToolContent } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fromLangChainTool } from "../index";

/** Build a real LangChain tool whose invoke() yields `result`, then adapt it to Rejelly. */
function adapt(result: unknown, responseFormat?: "content" | "content_and_artifact") {
  const lcTool = tool(async () => result, {
    name: "fake_tool",
    description: "returns a fixed result",
    schema: z.object({}),
    responseFormat,
  });
  return fromLangChainTool(lcTool);
}

function partsOf(output: unknown): unknown {
  return (output as { $rejellyContent: unknown }).$rejellyContent;
}

describe("LangChain tool result normalization", () => {
  it("converts a v1 standard base64 image block into toolContent", async () => {
    const tool = adapt([
      { type: "text", text: "see image" },
      { type: "image", mimeType: "image/jpeg", data: "AAAA" },
    ]);

    const output = await tool.handler({});
    expect(isToolContent(output)).toBe(true);
    expect(partsOf(output)).toEqual([
      { type: "text", text: "see image" },
      { type: "image", image: { url: "data:image/jpeg;base64,AAAA" } },
    ]);
  });

  it("converts a v1 standard url image block into toolContent", async () => {
    const tool = adapt([{ type: "image", url: "https://example.com/a.png" }]);

    const output = await tool.handler({});
    expect(isToolContent(output)).toBe(true);
    expect(partsOf(output)).toEqual([
      { type: "image", image: { url: "https://example.com/a.png" } },
    ]);
  });

  it("converts a classic image_url block into toolContent", async () => {
    const tool = adapt([{ type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } }]);

    const output = await tool.handler({});
    expect(isToolContent(output)).toBe(true);
    expect(partsOf(output)).toEqual([
      { type: "image", image: { url: "data:image/png;base64,BBBB" } },
    ]);
  });

  it("converts blocks returned via content_and_artifact (invoke yields the array directly)", async () => {
    const tool = adapt(
      [[{ type: "image", url: "https://example.com/b.png" }], { citation: 1 }],
      "content_and_artifact",
    );

    const output = await tool.handler({});
    expect(isToolContent(output)).toBe(true);
    expect(partsOf(output)).toEqual([
      { type: "image", image: { url: "https://example.com/b.png" } },
    ]);
  });

  it("passes a plain string result through unchanged", async () => {
    const tool = adapt("just text");
    expect(await tool.handler({})).toBe("just text");
  });

  it("passes a text-only content-block array through unchanged", async () => {
    const blocks = [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ];
    const tool = adapt(blocks);
    const output = await tool.handler({});
    expect(isToolContent(output)).toBe(false);
    expect(output).toEqual(blocks);
  });
});
