# LangChain 工具适配器

`@rejelly/adapter-langchain` 提供 `fromLangChainTool`，用于将 LangChain 工具转换为 Rejelly 的 `ToolDefinition`，从而复用 LangChain 工具生态。

多模态工具结果的接收侧契约见 [Adapter · 多模态工具结果](/zh/api/adapter/#多模态工具结果-multimodal-tool-results)。

## `fromLangChainTool(tool, options?)`

**基本用法：**

```typescript
import { createAgent, equipSystem, equipTool, promptAgent } from '@rejelly/core';
import { fromLangChainTool } from '@rejelly/adapter-langchain';
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import { Calculator } from "@langchain/community/tools/calculator";

// 实例化 LangChain 工具
const tavilyTool = new TavilySearchResults({ apiKey: "..." });
const calcTool = new Calculator();

const ResearchAgent = createAgent({
  id: 'researcher',
  model: openaiModel,
  handler: async (props) => {
    equipSystem('你是一个善用工具的研究员。');

    // 直接转换并装备 LangChain 工具
    equipTool(fromLangChainTool(tavilyTool));

    // 重命名和自定义描述（可选）
    equipTool(fromLangChainTool(calcTool, {
      name: 'math_calculator',
      description: '当需要精确数值计算时必须使用此工具'
    }));

    const result = await promptAgent(ResultSchema);
    return result;
  }
});
```

**fromLangChainTool 接口：**

```typescript
/**
 * 将 LangChain 工具适配为 Rejelly 工具
 * @param tool - LangChain 工具实例（兼容 StructuredTool 和大多数工具实现）
 * @param options - 可选的覆盖配置
 */
function fromLangChainTool(
  tool: LangChainToolLike,
  options?: FromLangChainToolOptions
): ToolDefinition;

interface LangChainToolLike {
  name: string;
  description: string;
  schema?: z.ZodTypeAny;
  invoke?(input: any, options?: any): Promise<any>;
  call?: (input: any, options?: any): Promise<any>;
  func?: (input: any, options?: any): Promise<any>;
}

interface FromLangChainToolOptions {
  /** 覆盖工具名称 */
  name?: string;
  /** 覆盖工具描述 */
  description?: string;
}
```

**工作原理：**

- **鸭子类型兼容**：使用最小化接口（`LangChainToolLike`），避免强依赖 `langchain` 库
- **Schema 提取**：自动提取 LangChain 工具的 Zod Schema（现代工具通常直接暴露）
- **执行方法适配**：支持 `invoke()`、`call()`、`func()` 等多种执行方法（优先级：invoke > call > func）
- **AbortSignal 注入**：自动从 AgentContext 获取 `AbortSignal` 并传递给 LangChain 工具
- **多模态结果**：工具返回的 content-block 数组若含图片块，转成 `toolContent`（见 [Adapter · 多模态工具结果](/zh/api/adapter/#多模态工具结果-multimodal-tool-results)）；纯文本/未识别结果原样透传
- **错误处理**：友好的错误包装，保留原始错误上下文

**注意事项：**

- 如果工具没有 Zod Schema，会降级为 `z.any()` 并打印警告（可能降低 LLM 调用准确率）
- 建议使用支持 Zod Schema 的现代 LangChain 工具（如 `StructuredTool`）
- 可以通过 `options` 覆盖工具名称和描述，使其更符合当前 Agent 的上下文
- 适配器会自动处理 AbortSignal 传递，但某些旧版工具可能不支持
