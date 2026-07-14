/**
 * LangChain Adapter
 *
 * Adapter for converting LangChain tools to Rejelly ToolDefinition.
 * This allows Rejelly to leverage LangChain's extensive tool ecosystem
 * while maintaining Rejelly's clean control flow.
 *
 * Multimodal tool results (LangChain message content blocks carrying media, e.g. an image) are
 * converted to `toolContent` so they survive as native model-facing content.
 *
 * @packageDocumentation
 */

import {
  type ContentPart,
  getContextSignal,
  type ToolDefinition,
  toolContent,
} from "@rejelly/core";
import { z } from "zod";

/**
 * Minimal LangChain Tool interface (duck typing)
 *
 * Compatible with LangChain's StructuredTool and most tool implementations.
 * This avoids requiring the heavy langchain dependency in core.
 */
export interface LangChainToolLike {
  name: string;
  description: string;
  schema?: z.ZodTypeAny;
  // Method syntax (bivariant params) so real LangChain tools — whose execute methods take
  // narrower, generic input types — remain structurally assignable to this duck-typed interface.
  invoke?(input: unknown, options?: unknown): Promise<unknown>;
  call?(input: unknown, options?: unknown): Promise<unknown>;
  // Real LangChain `func` may also return an AsyncGenerator (streaming tools); we only consume the
  // awaited value, but the wider return type keeps real tools structurally assignable.
  func?(
    input: unknown,
    options?: unknown,
  ): Promise<unknown> | AsyncGenerator<unknown, unknown, unknown>;
}

/**
 * Options for fromLangChainTool adapter
 */
export interface FromLangChainToolOptions {
  name?: string;
  description?: string;
}

/** A media content block (image) inside a LangChain tool result needs native model-facing handling. */
function isMediaBlockType(type: unknown): boolean {
  return type === "image_url" || type === "image";
}

function isLangChainContentBlockArray(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { type?: unknown }).type === "string",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Resolve an image URL (or data URL) from a LangChain `type: "image"` block.
 *
 * Covers the current `@langchain/core` v1 standard block
 * (`ContentBlock.Multimodal.Image`: `{ url }` or `{ mimeType, data }`, camelCase, no `source_type`)
 * and the deprecated source_type form (`{ source_type, url | data, mime_type }`). Returns null when
 * the block carries no inline image (e.g. a `fileId`-only reference).
 */
function imageUrlFromImageBlock(block: Record<string, unknown>): string | null {
  if (typeof block.url === "string") {
    return block.url;
  }
  const data = block.data;
  const mimeType =
    (typeof block.mimeType === "string" && block.mimeType) ||
    (typeof block.mime_type === "string" && block.mime_type) ||
    "image/png";
  if (typeof data === "string") {
    return data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
  }
  if (data instanceof Uint8Array) {
    return `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;
  }
  return null;
}

/** Convert one LangChain message content block to a Rejelly ContentPart. */
function langChainBlockToContentPart(block: Record<string, unknown>): ContentPart {
  const type = block.type;
  if (type === "text") {
    return { type: "text", text: typeof block.text === "string" ? block.text : "" };
  }
  if (type === "image_url") {
    // Classic MessageContentComplex block: image_url is a string or { url }.
    const raw = block.image_url;
    const url =
      typeof raw === "string" ? raw : isRecord(raw) && typeof raw.url === "string" ? raw.url : "";
    if (url) {
      return { type: "image", image: { url } };
    }
  }
  if (type === "image") {
    const url = imageUrlFromImageBlock(block);
    if (url) {
      return { type: "image", image: { url } };
    }
  }
  return { type: "text", text: JSON.stringify(block) };
}

/**
 * Normalize a LangChain tool result for Rejelly.
 *
 * LangChain tools may return multimodal message content (an array of content blocks). When the
 * result carries media (e.g. an image), convert it to `toolContent` so it survives as native
 * model-facing content; otherwise pass the raw result through unchanged.
 *
 * Note: `tool().invoke(args)` returns the tool content directly (a string or a content-block
 * array) — including with `responseFormat: "content_and_artifact"` — not a `ToolMessage`, so no
 * unwrapping is needed here.
 */
function normalizeLangChainToolResult(result: unknown): unknown {
  if (!isLangChainContentBlockArray(result)) {
    return result;
  }
  const hasMedia = result.some((block) => isMediaBlockType(block.type));
  if (!hasMedia) {
    return result;
  }
  return toolContent(result.map(langChainBlockToContentPart));
}

/**
 * Convert LangChain tool to Rejelly ToolDefinition
 *
 * @param tool - LangChain tool instance (e.g. new TavilySearchResults())
 * @param options - Optional override configuration
 * @returns Rejelly ToolDefinition ready for equipTool()
 */
export function fromLangChainTool(
  tool: LangChainToolLike,
  options?: FromLangChainToolOptions,
): ToolDefinition {
  if (!tool.name) {
    throw new Error("LangChain tool must have a name property");
  }
  if (!tool.description) {
    throw new Error("LangChain tool must have a description property");
  }

  let parameters: z.ZodTypeAny;

  if (tool.schema) {
    const schemaObj = tool.schema as unknown as Record<string, unknown>;
    const isZodSchema =
      typeof tool.schema === "object" &&
      tool.schema !== null &&
      "_def" in schemaObj &&
      "parse" in schemaObj &&
      typeof (schemaObj.parse as (v: unknown) => unknown) === "function";

    if (isZodSchema) {
      parameters = tool.schema;
    } else {
      console.warn(
        `[@rejelly/adapter-langchain] Tool ${tool.name} has non-Zod schema. ` +
          "Using z.any() which may reduce LLM calling accuracy. " +
          "Consider using a tool with proper Zod schema.",
      );
      parameters = z.any();
    }
  } else {
    console.warn(
      `[@rejelly/adapter-langchain] Tool ${tool.name} does not have a schema property. ` +
        "Using z.any() which may reduce LLM calling accuracy. " +
        "Consider using a tool with proper Zod schema.",
    );
    parameters = z.any();
  }

  const executeMethod = tool.invoke ?? tool.call ?? tool.func;

  if (!executeMethod) {
    throw new Error(
      `LangChain tool "${tool.name}" must have one of: invoke(), call(), or func() method`,
    );
  }

  return {
    name: options?.name ?? tool.name,
    description: options?.description ?? tool.description,
    parameters,
    handler: async (args: unknown) => {
      try {
        const signal = getContextSignal();
        const toolOptions: { signal?: AbortSignal; configurable?: { signal?: AbortSignal } } = {};
        if (signal) {
          toolOptions.signal = signal;
          toolOptions.configurable = { signal };
        }
        const result = await executeMethod.call(tool, args, toolOptions);
        return normalizeLangChainToolResult(result);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`LangChain Tool [${tool.name}] failed: ${message}`);
      }
    },
  };
}
