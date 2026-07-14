# Adapter (适配器)

适配器模块把外部模型、工具与协议生态接入 Rejelly。适配器按职责分成两类：

- **模型适配器**：把 provider 模型包装成 Rejelly `ModelAdapter`，见 [Model Adapter (OpenAI / Gemini)](/zh/api/adapter/model)。
- **工具 / 来源适配器**：把外部工具生态转换成 Rejelly `ToolDefinition`，见 [MCP](/zh/api/adapter/mcp) 与 [LangChain](/zh/api/adapter/langchain)。

适配器已从 `@rejelly/core` 中移出，以独立包形式发布。按需安装对应包即可：

| 包 | 用途 |
|----|------|
| `@rejelly/adapter-openai` | OpenAI 模型适配器，提供 `createOpenAIAdapter` |
| `@rejelly/adapter-gemini` | Gemini 模型适配器，提供 `createGeminiAdapter` |
| `@rejelly/adapter-mcp` | MCP 工具 / 资源 / prompt 集成，提供 `equipMCP` / `fromMCPTool` |
| `@rejelly/adapter-langchain` | LangChain 工具适配，提供 `fromLangChainTool` |

## 多模态工具结果 (Multimodal tool results)

工具可以返回模型可见的多模态内容（如图片），方式是用 `@rejelly/core` 的 `toolContent(parts: ContentPart[])` 包裹结果。普通 JSON / 字符串结果仍按原样字符串化，只有被 `toolContent` 标记的对象会作为 `MessageContent` 直接进入对话。两类适配器在不同侧各自处理：

**Model adapter（OpenAI / Gemini）—— 发送侧自动拆分。** 多数 provider 的 tool / function 结果消息**只能携带文本**。当某条 tool 消息含媒体（如经 `toolContent` 返回的图片）时，消息转换器会**自动把它拆成两条**：一条纯文本的 tool 结果 + 紧随其后的一条 `user` 消息承载媒体，从而让模型真正“看到”图。纯文本工具结果不受影响，仍是单条。

- **OpenAI**（`toOpenAIMessages`）：`tool`（文本，纯媒体时用占位句）→ `user`（`image_url`）。
- **Gemini**（`toGeminiMessages`）：`functionResponse`（文本）→ `user` Content（`inlineData`）。注意这会产生连续两个 client-side 轮（`function` 紧接 `user`）。

> 这是适配器在“provider 能力边界”上做的归一化：知道哪种 provider 不能在工具结果里带图的，只有适配器层。因此该转换放在适配器、对所有 policy 与上层 Agent 透明生效，无需 metatool 或额外往返。

**工具 / 来源 adapter（MCP / LangChain）—— 接收侧转成 `toolContent`。** 当工具自身返回多模态内容块（含图片）时，适配器会把它转换成 `toolContent`，以便作为原生模型可见内容流入上面的发送侧；**纯文本或未识别的结果原样透传**，不改变既有行为。

- **MCP**（`formatCallToolResult`）：`image` 块 → 图片 `ContentPart`；`resource` 块按文本/标签降级。
- **LangChain**（`fromLangChainTool`）：content-block 数组中的经典 `image_url` 与标准 `image`（`source_type: "base64" | "url"`）块 → 图片 `ContentPart`。
