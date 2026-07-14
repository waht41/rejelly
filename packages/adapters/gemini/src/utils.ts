/**
 * Data structure mapping between @rejelly/core and Gemini API.
 * All exports are pure or async with minimal side effects (convertContentPartToGeminiPart
 * uses fetch for remote image URLs; can be mocked in tests).
 */

import {
  type Content,
  FunctionCallingConfigMode,
  type Part,
  type Schema,
  type Tool,
} from "@google/genai";
import type { ContentPart, Message, ToolChoice, ToolDefinition } from "@rejelly/core";
import { zodToJsonSchema } from "zod-to-json-schema";

// ── Schema injection (for models without native JSON Schema) ─────────────────

export function generateSchemaInstruction(schema: Record<string, unknown>): string {
  const schemaStr = JSON.stringify(schema, null, 2);
  return `\n\n## Response Format

You MUST respond with a valid JSON object that strictly conforms to the following JSON Schema:

\`\`\`json
${schemaStr}
\`\`\`

Important Rules:
- The core of your response MUST be the JSON object.
- Do NOT output any conversational text, pleasantries, or explanations.
- Ensure all required fields are present and follow the exact types specified.
- If additional formatting protocols are provided by model middleware, follow them exactly.`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Cross-platform ArrayBuffer to base64 (avoids Node-only Buffer for Edge/browser). */
export function arrayBufferToBase64(arrayBuffer: ArrayBuffer): string {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ── ContentPart → Gemini Part ──────────────────────────────────────────────

/**
 * Converts a single ContentPart to a Gemini Part. Has side effect: fetches
 * remote image URLs. For unit tests, consider mocking global fetch.
 */
export async function convertContentPartToGeminiPart(part: ContentPart): Promise<Part> {
  if (part.type === "text") {
    return { text: part.text };
  }

  if (part.type === "image") {
    const imageUrl = part.image.url;

    if (imageUrl.startsWith("data:")) {
      const commaIdx = imageUrl.indexOf(",");
      const header = commaIdx >= 0 ? imageUrl.substring(0, commaIdx) : imageUrl;
      const data = commaIdx >= 0 ? imageUrl.substring(commaIdx + 1) : "";
      const mimeMatch = header.match(/data:([^;]+)/);
      const mimeType = mimeMatch ? mimeMatch[1] : "image/png";
      return { inlineData: { mimeType, data } };
    }

    if (imageUrl.startsWith("gs://")) {
      return { fileData: { mimeType: "image/jpeg", fileUri: imageUrl } };
    }

    try {
      const response = await fetch(imageUrl);
      const arrayBuffer = await response.arrayBuffer();
      const base64 = arrayBufferToBase64(arrayBuffer);
      const mimeType = response.headers.get("content-type") || "image/jpeg";
      return { inlineData: { mimeType, data: base64 } };
    } catch (error) {
      console.warn(`[@rejelly/adapter-gemini] Failed to fetch image ${imageUrl}:`, error);
      return { text: `[Image: ${imageUrl}]` };
    }
  }

  if (part.type === "video") {
    return {
      fileData: {
        mimeType: "video/mp4",
        fileUri: part.video.url,
      },
    };
  }

  // Avoid empty text part; Gemini may reject it
  return { text: "[unknown part type]" };
}

// ── Messages → Gemini Content ─────────────────────────────────────────────
//
// Gemini alternation rule: client side and server side must alternate.
// - Client side: "user" (user input) and "function" (tool results sent back).
// - Server side: "model" (text reply or functionCall).
// We merge consecutive messages of the same role into one Content (same side
// can have multiple parts, e.g. multiple functionResponse in one "function" Content).

/** Tool result text when a tool returns media only — points the model at the follow-up user turn. */
const TOOL_MEDIA_FALLBACK_TEXT =
  "[Tool returned non-text content; see the following user message.]";

/**
 * Ensure Gemini functionResponse.response is always a key-value object (not a raw string).
 *
 * Gemini functionResponse is text-only. Media parts (e.g. an image via `toolContent`) are
 * stripped here and forwarded by {@link toGeminiMessages} as a following user turn.
 */
export function toFunctionResponseObject(content: Message["content"]): Record<string, unknown> {
  if (content == null) return { content: "" };
  if (typeof content === "string") return { content };

  const text = content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  const hasMedia = content.some((part) => part.type !== "text");
  if (hasMedia && text.length === 0) {
    return { content: TOOL_MEDIA_FALLBACK_TEXT };
  }
  return { content: text };
}

function createGeminiReasoningPart(reasoning: string): Part {
  // Gemini thought parts are represented as text with `thought: true`.
  return {
    text: reasoning,
    thought: true,
  } as Part;
}

/**
 * Convert Rejelly messages to Gemini Content[].
 *
 * Gemini functionResponse is text-only, so a tool message carrying media (e.g. an image returned
 * via `toolContent`) is automatically split into a text functionResponse plus a follow-up `user`
 * Content holding the media, so the model can actually see it.
 */
export async function toGeminiMessages(messages: Message[]): Promise<Content[]> {
  const result: Content[] = [];

  // Merge consecutive same-role (same "side") into one Content.
  const appendContent = (role: "model" | "user" | "function", parts: Part[]): void => {
    if (parts.length === 0) return;
    const lastContent = result[result.length - 1];
    if (lastContent && lastContent.role === role) {
      lastContent.parts ??= [];
      lastContent.parts.push(...parts);
    } else {
      result.push({ role, parts });
    }
  };

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "tool") {
      // function role: parts must be functionResponse only; response must be an object
      appendContent("function", [
        {
          functionResponse: {
            name: msg.name || "unknown_tool",
            response: toFunctionResponseObject(msg.content),
          },
        },
      ]);
      // functionResponse is text-only; forward any media as a following user turn so the
      // model can actually see it (e.g. an image returned via `toolContent`).
      const mediaParts: ContentPart[] = Array.isArray(msg.content)
        ? msg.content.filter((part) => part.type !== "text")
        : [];
      if (mediaParts.length > 0) {
        const userParts: Part[] = [{ text: `Tool result content for ${msg.name || "tool"}:` }];
        for (const part of mediaParts) {
          userParts.push(await convertContentPartToGeminiPart(part));
        }
        appendContent("user", userParts);
      }
      continue;
    }

    const role: "model" | "user" = msg.role === "assistant" ? "model" : "user";
    const parts: Part[] = [];

    // user or model: text / multimodal / functionCall
    // Do NOT push empty text: Gemini rejects { text: "" } and disallows it alongside functionCall.
    if (msg.role === "assistant" && msg.reasoning_content) {
      parts.push(createGeminiReasoningPart(msg.reasoning_content));
    }
    if (msg.content) {
      if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      } else {
        for (const part of msg.content) {
          parts.push(await convertContentPartToGeminiPart(part as ContentPart));
        }
      }
    }
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      for (const call of msg.tool_calls) {
        const functionCallPart: Part = {
          functionCall: {
            name: call.name,
            args: JSON.parse(call.arguments || "{}"),
          },
        };
        const thoughtSignature = call.extra?.thoughtSignature;
        if (typeof thoughtSignature === "string" && thoughtSignature.length > 0) {
          // Gemini expects thoughtSignature on functionCall parts when tool loop continues.
          (functionCallPart as Part & { thoughtSignature?: string }).thoughtSignature =
            thoughtSignature;
        }
        parts.push(functionCallPart);
      }
    }

    // Skip this message if no valid parts (do not push { text: "" } as fallback)
    appendContent(role, parts);
  }

  return result;
}

/**
 * Extracts system message(s) as Gemini systemInstruction.
 * Returns string when only text; returns Content (with parts) when any image/video so Gemini accepts multimodal system instruction.
 */
export async function extractSystemInstruction(
  messages: Message[],
): Promise<string | Content | undefined> {
  const systemMessages = messages.filter((msg) => msg.role === "system");
  if (systemMessages.length === 0) return undefined;

  const isMultiModel = systemMessages.some((msg) => {
    if (!msg.content || typeof msg.content === "string") return false;
    return (msg.content as ContentPart[]).some((p) => p.type !== "text");
  });

  if (!isMultiModel) {
    const text = systemMessages
      .map((msg) => {
        if (typeof msg.content === "string") return msg.content;
        return (msg.content as ContentPart[])
          .filter((p) => p.type === "text")
          .map((p) => (p as { type: "text"; text: string }).text)
          .join("\n");
      })
      .join("\n\n");
    return text || undefined;
  }

  const parts: Part[] = [];
  for (const msg of systemMessages) {
    if (!msg.content) continue;
    if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    } else {
      for (const part of msg.content as ContentPart[]) {
        parts.push(await convertContentPartToGeminiPart(part));
      }
    }
  }
  if (parts.length === 0) return undefined;
  return { role: "system", parts };
}

// ── Tools ──────────────────────────────────────────────────────────────────

export function toGeminiTools(tools: ToolDefinition[]): Tool[] {
  if (tools.length === 0) return [];

  return [
    {
      functionDeclarations: tools.map((tool) => {
        const jsonSchema = zodToJsonSchema(tool.parameters, { $refStrategy: "none" });
        return {
          name: tool.name,
          description: tool.description,
          parameters: jsonSchema as Schema,
        };
      }),
    },
  ];
}

export function toGeminiToolChoice(toolChoice: ToolChoice): FunctionCallingConfigMode | undefined {
  if (toolChoice === "auto") return FunctionCallingConfigMode.AUTO;
  if (toolChoice === "none") return FunctionCallingConfigMode.NONE;
  if (toolChoice === "required") return FunctionCallingConfigMode.ANY;
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    return FunctionCallingConfigMode.ANY;
  }
  return undefined;
}
