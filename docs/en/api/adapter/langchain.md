# LangChain Tool Adapter

`@rejelly/adapter-langchain` provides `fromLangChainTool` for converting LangChain tools into Rejelly `ToolDefinition`, enabling reuse of the LangChain tool ecosystem.

For the receive-side contract of multimodal tool results, see [Adapter · Multimodal Tool Results](/en/api/adapter/#multimodal-tool-results).

## `fromLangChainTool(tool, options?)`

**Basic usage:**

```typescript
import { createAgent, equipSystem, equipTool, promptAgent } from '@rejelly/core';
import { fromLangChainTool } from '@rejelly/adapter-langchain';
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import { Calculator } from "@langchain/community/tools/calculator";

// Instantiate LangChain tools
const tavilyTool = new TavilySearchResults({ apiKey: "..." });
const calcTool = new Calculator();

const ResearchAgent = createAgent({
  id: 'researcher',
  model: openaiModel,
  handler: async (props) => {
    equipSystem('You are a researcher who excels at using tools.');

    // Directly convert and equip a LangChain tool
    equipTool(fromLangChainTool(tavilyTool));

    // Rename and customize description (optional)
    equipTool(fromLangChainTool(calcTool, {
      name: 'math_calculator',
      description: 'Must use this tool when precise numerical calculations are needed'
    }));

    const result = await promptAgent(ResultSchema);
    return result;
  }
});
```

**fromLangChainTool interface:**

```typescript
/**
 * Adapts a LangChain tool to a Rejelly tool
 * @param tool - LangChain tool instance (compatible with StructuredTool and most tool implementations)
 * @param options - Optional override configuration
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
  /** Override the tool name */
  name?: string;
  /** Override the tool description */
  description?: string;
}
```

**How it works:**

- **Duck typing compatibility**: Uses a minimal interface (`LangChainToolLike`) to avoid a hard dependency on the `langchain` library
- **Schema extraction**: Automatically extracts the Zod Schema from LangChain tools (modern tools typically expose it directly)
- **Execution method adaptation**: Supports `invoke()`, `call()`, `func()` and other execution methods (priority: invoke > call > func)
- **AbortSignal injection**: Automatically retrieves `AbortSignal` from AgentContext and passes it to LangChain tools
- **Multimodal results**: Content-block arrays returned by tools that include image blocks are converted to `toolContent` (see [Adapter · Multimodal Tool Results](/en/api/adapter/#multimodal-tool-results)); plain text / unrecognized results pass through unchanged
- **Error handling**: Friendly error wrapping that preserves the original error context

**Notes:**

- If a tool lacks a Zod Schema, it degrades to `z.any()` and prints a warning (this may reduce LLM call accuracy)
- Use modern LangChain tools that support Zod Schema (e.g. `StructuredTool`) for best results
- You can override the tool name and description via `options` to better fit the current Agent context
- The adapter automatically handles AbortSignal passing, but some older tools may not support it
