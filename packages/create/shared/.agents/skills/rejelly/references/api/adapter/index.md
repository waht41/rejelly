# Adapter

Adapter modules connect external models, tools, and protocol ecosystems to Rejelly. Adapters fall into two categories by responsibility:

- **Model Adapters**: Wrap provider models into Rejelly's `ModelAdapter`, see [Model Adapter (OpenAI / Gemini)](/en/api/adapter/model).
- **Tool / Source Adapters**: Convert external tool ecosystems into Rejelly `ToolDefinition`, see [MCP](/en/api/adapter/mcp) and [LangChain](/en/api/adapter/langchain).

Adapters have been extracted from `@rejelly/core` and published as separate packages. Install the corresponding package as needed:

| Package | Purpose |
|---------|---------|
| `@rejelly/adapter-openai` | OpenAI model adapter, provides `createOpenAIAdapter` |
| `@rejelly/adapter-gemini` | Gemini model adapter, provides `createGeminiAdapter` |
| `@rejelly/adapter-mcp` | MCP tool / resource / prompt integration, provides `equipMCP` / `fromMCPTool` |
| `@rejelly/adapter-langchain` | LangChain tool adapter, provides `fromLangChainTool` |

## Multimodal Tool Results

Tools can return model-visible multimodal content (e.g., images) by wrapping the result with `toolContent(parts: ContentPart[])` from `@rejelly/core`. Regular JSON / string results are still stringified as-is; only objects marked by `toolContent` enter the conversation as `MessageContent`. The two adapter categories each handle this on their respective side:

**Model adapter (OpenAI / Gemini) — send-side auto-splitting.** Most providers only allow **text** in tool / function result messages. When a tool message contains media (e.g., an image returned via `toolContent`), the message converter **automatically splits it into two messages**: a plain-text tool result + an immediately following `user` message carrying the media, so the model can actually "see" the image. Plain-text tool results are unaffected and remain as a single message.

- **OpenAI** (`toOpenAIMessages`): `tool` (text, placeholder sentence when purely media) → `user` (`image_url`).
- **Gemini** (`toGeminiMessages`): `functionResponse` (text) → `user` Content (`inlineData`). Note this produces two consecutive client-side turns (`function` directly followed by `user`).

> This is normalization performed by the adapter at the "provider capability boundary": only the adapter layer knows which providers cannot carry images in tool results. Hence this conversion lives in the adapter, transparent to all policies and upper-level Agents — no metatool or extra round-trips needed.

**Tool / source adapter (MCP / LangChain) — receive-side conversion to `toolContent`.** When a tool itself returns multimodal content blocks (including images), the adapter converts them into `toolContent` so they flow as native model-visible content into the send-side above; **plain text or unrecognized results pass through unchanged**, preserving existing behavior.

- **MCP** (`formatCallToolResult`): `image` blocks → image `ContentPart`; `resource` blocks degraded by text/label.
- **LangChain** (`fromLangChainTool`): Classic `image_url` and standard `image` (`source_type: "base64" | "url"`) blocks in content-block arrays → image `ContentPart`.
