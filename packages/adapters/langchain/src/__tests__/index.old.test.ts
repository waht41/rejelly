/**
 * Cross-version test: the classic `@langchain/core` 0.3 content-block shapes
 * (installed under the `lc-core-old` alias) — classic `image_url` blocks and the deprecated
 * `source_type` image blocks. The v1 (1.x) shapes are covered in `index.test.ts`.
 */

import { isToolContent } from "@rejelly/core";
import { tool } from "lc-core-old/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fromLangChainTool } from "../index";

function adapt(result: unknown) {
  const lcTool = tool(async () => result, {
    name: "fake_tool",
    description: "returns a fixed result",
    schema: z.object({}),
  });
  return fromLangChainTool(lcTool);
}

function partsOf(output: unknown): unknown {
  return (output as { $rejellyContent: unknown }).$rejellyContent;
}

describe("LangChain 0.3 (classic) tool result normalization", () => {
  it("converts a classic image_url block into toolContent", async () => {
    const tool = adapt([
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);

    const output = await tool.handler({});
    expect(isToolContent(output)).toBe(true);
    expect(partsOf(output)).toEqual([
      { type: "text", text: "hi" },
      { type: "image", image: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  it("converts a deprecated source_type base64 image block into toolContent", async () => {
    const tool = adapt([
      { type: "image", source_type: "base64", data: "BBBB", mime_type: "image/jpeg" },
    ]);

    const output = await tool.handler({});
    expect(isToolContent(output)).toBe(true);
    expect(partsOf(output)).toEqual([
      { type: "image", image: { url: "data:image/jpeg;base64,BBBB" } },
    ]);
  });

  it("converts a deprecated source_type url image block into toolContent", async () => {
    const tool = adapt([{ type: "image", source_type: "url", url: "https://ex.com/c.png" }]);

    const output = await tool.handler({});
    expect(isToolContent(output)).toBe(true);
    expect(partsOf(output)).toEqual([{ type: "image", image: { url: "https://ex.com/c.png" } }]);
  });
});
