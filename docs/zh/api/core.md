# Core (核心定义)

## `createAgent(config)`

定义一个可复用的 Agent 单元。

```typescript
import { createAgent, ModelAdapter } from '@rejelly/core';

// 假设已有一个 OpenAI 适配器
const openaiModel: ModelAdapter = createOpenAIAdapter({ modelId: 'gpt-5.6-luna' });

// handler 接收上层传来的 props (指令、参数)
export const SearchAgent = createAgent({
  id: 'search_agent',
  model: openaiModel, // ModelAdapter 实例
  maxRetries: 3,   // 可选，promptAgent(schema) / expectValidator 验证失败时的最大重试次数（默认 3）
  handler: async (props) => {
     // ... 逻辑代码
     return result;
  }
});

// ✅ Agent 即函数：直接调用，无需 .handler
// 框架自动处理上下文创建、reborn 循环等运行时细节
const result = await SearchAgent({ topic: 'hello' });
```

**createAgent 配置项：**

| 属性 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `id` | `string` | ✅ | - | Agent 唯一标识，用于日志和持久化 |
| `model` | `string \| ModelAdapter` | ❌ | - | 模型：传 `ModelAdapter` 实例直接使用；传 `string` 时在运行期从 `runWith` 的 `modelRegistry`（即 `shared.modelRegistry`）按 id 解析，便于多租户下按租户注入带限流等中间件的模型 |
| `maxRetries` | `number` | ❌ | `3` | promptAgent(schema) / expectValidator 验证失败时的最大重试次数 |
| `maxReborns` | `number` | ❌ | `100` | reborn 次数上限(数 **reborn 事件**,非 generation:`N` 次 reborn = `N+1` 个 generation)。超限抛 `RebornLimitExceededError`。活性兜底,防 reborn 死循环——典型成因是用 handler 局部变量当跨代计数器,每次 reborn 归零永不收敛;跨代计数应走 `equipMemory`(`return reborn()` 前先 `set`)。合法的深 reborn 链调大此值 |
| `handler` | `(props) => Promise<Result>` | ✅ | - | 核心逻辑函数 |

## `ModelAdapter` 接口

```typescript
interface ModelAdapter {
  /** 模型标识（用于日志/调试） */
  id: string;
  
  /** 模型提供商（可选） */
  provider?: string;
  
  /** 流式调用 LLM */
  stream(messages: Message[], options?: ModelStreamOptions): AsyncGenerator<StreamEvent>;
  
  /** 成本计算器（可选）；按计费单位返回整数，如 micro_usd、credit（与 Budget / equipBudget 的 costs 一致） */
  calculateCost?(usage: TokenUsage): Record<string, number>;
}

interface ModelStreamOptions {
  schema?: JsonSchema;      // 可选的 JSON Schema，用于结构化输出
  tools?: ToolDefinition[]; // 本轮可调用的工具定义
  toolChoice?: ToolChoice;  // 工具调用策略（与 tools 配套）
  signal?: AbortSignal;     // 可选的 AbortSignal，用于中断流式输出
  additionalOptions?: Record<string, unknown>; // 透传给各适配器的扩展项
}

/** 流式工具调用增量（与 OpenAI streaming tool_calls 类似，按 index 合并） */
interface ToolCallChunk {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
  extra?: Record<string, unknown>;
}

// 流式事件类型（Tagged Union）
type StreamEvent =
  | { type: 'text'; content: string }       // 正文增量
  | { type: 'reasoning'; content: string }  // 推理/思考增量（链式思维类模型，如 DeepSeek-R1）
  | { type: 'tool_call'; toolCall: ToolCallChunk }  // 工具调用流式分片（按 index 累积为完整 ToolCall）
  | { type: 'extra'; extra: Record<string, unknown> } // 适配器/模型返回的额外元数据
  | { type: 'usage'; usage: TokenUsage }    // 统计数据（流式过程中可出现多次）
  | { type: 'finish'; finishReason: FinishReason; usage?: TokenUsage }  // 流结束（通常最后一条）
  | { type: 'error'; error: unknown };     // 流式错误

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  details?: {
    reasoningTokens?: number;   // 推理 token（计费相关）
    cacheReadTokens?: number;   // 从 prompt cache 读取的 token
    cacheWriteTokens?: number;  // 写入 prompt cache 的 token
    [key: string]: number | undefined;
  };
}

interface Message {
  role: MessageRole;
  content: MessageContent | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;  // 工具调用 ID（仅 tool 角色使用）
  name?: string;
  extra?: Record<string, unknown>;
}
```

`ModelStreamOptions` 中的 `ToolDefinition`、`ToolChoice` 与框架 equip 工具所用类型一致，由 `@rejelly/core` 导出。`MessageContent` 为 `string | ContentPart[]`（文本、图片、视频等多模态内容），`FinishReason` 取值见类型定义：`stop`、`length`、`tool_calls`、`content_filter`、`error`、`unknown`。

**OpenAI Adapter 实现示例：**

生产环境**推荐**从 `@rejelly/adapter-openai` 引入 `createOpenAIAdapter`（安装见 [Adapter · Model](/zh/api/adapter/model)），勿复制粘贴下方手写 `stream`。**下面整段仅作演示**：帮助理解 `ModelAdapter`、与 `calculateCost`（含 `micro_usd` / `credit`）如何配合 Budget。

**直接引入适配器（推荐）：**

```typescript
import { createOpenAIAdapter } from '@rejelly/adapter-openai';

const model = createOpenAIAdapter({
  modelId: 'gpt-5.6-luna',
  apiKey: process.env.OPENAI_API_KEY!,
  // Optional: integer Record for budget (e.g. micro_usd + credit); see demo below
  // calculateCost: (usage) => ({ ... }),
});
```

**手写样例：**

```typescript
const openaiAdapter: ModelAdapter = {
  id: 'gpt-5.6-luna',
  provider: 'openai',

  async *stream(messages, options) {
    const response = await openai.chat.completions.create({
      model: 'gpt-5.6-luna',
      messages,
      stream: true,
      stream_options: { include_usage: true },
      response_format: options?.schema
        ? { type: 'json_schema', json_schema: options.schema }
        : undefined,
    }, {
      signal: options?.signal,
    });
    
    let usage: TokenUsage | undefined;
    for await (const chunk of response) {
      if (options?.signal?.aborted) {
        throw new Error('Aborted');
      }
      
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }
      
      const text = chunk.choices[0]?.delta?.content;
      if (text) {
        yield { type: 'text', content: text };
      }
      
      if (chunk.choices[0]?.finish_reason === 'stop' && usage) {
        yield { type: 'usage', usage };
      }
    }
  },
  
  calculateCost(usage) {
    // GPT-5.6 Luna: $1/1M input, $6/1M output — integer micro USD per token (see budget.md / model-pricing examples)
    const microUsd = Math.round(usage.promptTokens * 1 + usage.completionTokens * 6);
    if (microUsd === 0) return {};
    // Credit is calculated based on micro_usd (not the number of tokens), with 1 credit approximately equal to 1 milli-USD.
    const MICRO_USD_PER_CREDIT_PARITY = 10_000;
    // Margin >= 1: commercial premium so internal credits do not undercharge vs provider cost (tune per product)
    const CREDIT_MARGIN = 1.15;
    const credit = Math.ceil((microUsd / MICRO_USD_PER_CREDIT_PARITY) * CREDIT_MARGIN);
    return { micro_usd: microUsd, credit };
  }
};
```

## `augmentModel(model, middlewares)`

增强 ModelAdapter，采用洋葱模型（从右到左组合，从外到内执行）。

```typescript
import { augmentModel } from '@rejelly/core';
import { withSimpleLimit } from '@rejelly/limit-model';

// 假设用户已实现：withLog 在请求前后打日志
const openaiAdapter = createOpenAIAdapter({ modelId: 'gpt-5.6-luna' });

const enhancedModel = augmentModel(openaiAdapter, [
  withSimpleLimit({ rpm: 60, concurrency: 5 }),  // 限流（来自 limit-model）
  withLog(),  // 日志
]);

// 洋葱模型：中间件从右到左组合，执行时 request 先经最外层再进内层，response 原路返回
// request  → limit → log → openai
// response ← limit ← log ← openai
```

## `augmentTool(tool, middlewares)`

为 ToolDefinition 添加静态中间件（“烧录”到工具定义中，定义一次、全局复用）。这些静态中间件会在动态中间件（来自 `equipTool` 的 `middleware` 选项）之后、handler 之前执行。

```typescript
import { augmentTool, equipTool } from '@rejelly/core';

const BaseSearchTool: ToolDefinition = {
  name: 'search',
  description: 'Search the web',
  parameters: z.object({ query: z.string() }),
  handler: async ({ query }) => await searchAPI(query),
};

const SafeSearchTool = augmentTool(BaseSearchTool, [
  wrapLog(),            // Outer: 记录日志
  wrapRetry({ n: 3 })   // Inner: 重试机制
]);

// 在 Agent 中使用
const ResearchAgent = createAgent({
  id: 'researcher',
  model: enhancedModel,
  handler: async (props) => {
    equipTool(SafeSearchTool);
    equipTool(SafeSearchTool, {
      middleware: [
        async (ctx, next) => {
          const [history, setHistory] = equipMemory('history', []);
          const result = await next();
          setHistory([...history, `Used ${ctx.toolName}`]);
          return result;
        }
      ]
    });
    return await promptAgent(ResultSchema);
  }
});
```

## `equipToolCallLoopMiddleware(middleware)`

### `promptAgent` 内部流程与本中间件介入点

一次 `promptAgent(schema)` 会在**单次 Generation** 内驱动「模型请求 → 解析响应」的循环，直到得到符合 schema 的结构化输出（或失败）。典型路径可概括为：

1. **首包及后续 turn**：用当前 draft（system、instruction、tools、历史消息等）调用模型流式接口。
2. **若模型返回 `tool_calls`**：框架进入 **tool call loop** 的**一步**——先跑本页所述的 **`ToolCallLoopMiddleware` 链**（若有注册），再按调用列表执行各工具的 handler（含 `equipTool` 动态 / `augmentTool` 静态中间件），将结果整理为 tool 消息写回对话，再继续请求模型。
3. **若模型返回符合 schema 的最终内容**：循环结束，`promptAgent` 返回解析后的结果。
4. 若仍需多轮「模型 → tool → 模型」，则重复 2～3，直到满足结束条件或达到框架限制。

**本中间件实际起作用的位置**：仅在上述**第 2 步**、且仅限于 **`promptAgent` 内部**处理「模型当轮产出的 `tool_calls`」时——即在把这一批调用交给底层 `executeToolOutputs` 执行**之前**，对**整批** `ToolCall[]` 做过滤或短路。它不参与拼 system/instruction，也不替代单工具层的 `ToolMiddleware`。

> **⚠️ 作用域：promptAgent 内部的 tool call loop，不是「全局工具执行」**
>
> `ToolCallLoopMiddleware` 绑定在 **`promptAgent` 自带的 tool 往返循环**上（与模型对话里的 tool 轮次一一对应）。**不会**在其它入口执行工具时触发。
>
> 例如：通过 **`callTool(tool, args)`** 在代码里**直接执行**某个 `ToolDefinition` 时，走的是单工具核心路径，**不会**经过 `equipToolCallLoopMiddleware`；同理，任何不经过「模型先产出 `tool_calls` → `promptAgent` 内部再派发执行」的路径，都不会跑 Loop 中间件。若需要在「手动调工具」场景做统一拦截，应在单工具 **`equipTool(..., { middleware })` / `augmentTool`** 上处理，而不是依赖 Loop 中间件。（注意：`callTool` 直接返回 handler 的原始输出，失败时**抛错**，不再兜底成字符串。）

**注册语义（与上文衔接）：** `equipToolCallLoopMiddleware` 即在上述第 2 步、模型已给出 `tool_calls` 且**尚未**进入各工具 handler / 单工具中间件之前插入一层。与「改 system / instruction / schema」无关：中间件**不能**修改本轮已参与哈希与快照的 prompt 与 schema，只作用于**整批 tool calls 执行前**这一跳，适合做限流、鉴权、过滤调用、或对部分调用**短路**并返回合成 `ToolOutput`（由框架再转成协议层的 `role: "tool"` 消息）。

**须在 `promptAgent()` 之前调用**（与 `equipTool` 同属 draft barrier，违反则 `AfterPromptAgentError`）。

**执行顺序（洋葱，与 `equipTool` 动态中间件一致）：** 数组**先注册者为外层**，后注册者更靠近真实执行。外层调用 `next(filteredCalls)` 时，内层收到的 **`currentCalls` 即为过滤后的列表**；最外层第一次收到的 `currentCalls` 与 `ctx.originalCalls` 一致（模型当轮原始 `tool_calls`）。`ctx` 为只读快照，其中 `originalCalls` 始终为模型请求；**随链路透传的是 `currentCalls` 参数**。

拦截时若只把「放行」的调用交给 `next(filtered)`，却**没有**为被拦下的调用提供合成 `ToolOutput`，则本批次的 tool 结果会少于模型请求的 `tool_calls` 条数，对话无法对齐。框架在合并中间件返回值后会校验：**当前批次每一个 `ToolCall.id` 都必须有且仅有一条对应 `callId` 的 `ToolOutput`**；若发现缺失且你未自行兜底，会抛出 **`LoopMissingToolOutputError`**（`@rejelly/core` 导出，可用 `isLoopMissingToolOutputError` 判断）。

正确做法是：**分流** → 对放行列表调用 `next` 得到真实执行结果 → **与拦截侧伪造的结果合并**后再 `return`，保证「N 个输入对应 N 个输出」。

```typescript
import { equipToolCallLoopMiddleware } from '@rejelly/core';

equipToolCallLoopMiddleware({
  name: 'rate-limit-search',
  handler: async (ctx, currentCalls, next) => {
    const validCalls = [];
    const blockedOutputs = [];

    // 1. 分流：合法的放行，非法的就地拦截并伪造输出
    for (const call of currentCalls) {
      if (call.name === 'search') {
        blockedOutputs.push({
          callId: call.id, // 必须归还 callId
          content: JSON.stringify({
            error: 'Search tool is currently rate-limited and blocked.',
          }),
        });
      } else {
        validCalls.push(call);
      }
    }

    // 2. 将合法的往下传，获取真实执行结果
    const realOutputs = validCalls.length > 0 ? await next(validCalls) : [];

    // 3. 必须合并！确保 N 个输入对应 N 个输出
    return [...realOutputs, ...blockedOutputs];
  },
});
```

**`ToolCallLoopMiddleware` 形态摘要：**

```typescript
handler: (
  ctx: ToolCallLoopContext,
  currentCalls: ToolCall[],
  next: (calls: ToolCall[]) => Promise<ToolOutput[]>,
) => Promise<ToolOutput[]>;
```

- **`ctx`**：当前循环步 **`step`**、`systemInstruction`、`instruction`、已完成轮次的 **`toolTurns`**（结构化历史）、以及本轮模型原始请求 **`originalCalls`** 等只读字段。
- **`currentCalls`**：当前层实际收到的调用列表（外层过滤后会变短）。
- **返回值**：与 `next()` 相同，为 **`ToolOutput[]`**（`callId` + `content`），框架负责映射为发给模型的 tool 消息，中间件无需拼 `role` / `tool_call_id`。

## `augmentAgent(agent, middlewares)`

为 AgentFunction 添加静态中间件（在 Agent 被调用时按洋葱模型执行）。

```typescript
import { augmentAgent } from '@rejelly/core';

const BaseAgent = createAgent({
  id: 'researcher',
  model: enhancedModel,
  handler: async (props) => {
    equipTool(SafeSearchTool);
    return await promptAgent(ResultSchema);
  }
});

const LoggedAgent = augmentAgent(BaseAgent, [
  {
    name: 'log',
    handler: async (ctx, next) => {
      console.log(`Agent ${ctx.agentId} called with`, ctx.props);
      const result = await next();
      console.log(`Agent ${ctx.agentId} returned`, result);
      return result;
    }
  },
  {
    name: 'monitor',
    handler: async (ctx, next) => {
      const start = Date.now();
      const result = await next();
      const duration = Date.now() - start;
      console.log(`Agent ${ctx.agentId} execution time: ${duration}ms`);
      return result;
    }
  }
]);

// 执行顺序（洋葱模型，从右到左组合）：
// request  → log → monitor → BaseAgent handler
// response ← log ← monitor ← BaseAgent handler
```

**ModelMiddleware 接口：**

```typescript
interface ModelMiddleware {
  /** 中间件名称（用于调试和日志） */
  name: string;

  /** 包装逻辑 */
  wrap: (inner: ModelAdapter) => ModelAdapter;
}
```

**ToolMiddleware 接口：**

```typescript
interface ToolMiddleware {
  /** 中间件名称（用于调试和日志） */
  name: string;

  /** 中间件处理函数 */
  handler: (ctx: ToolContext, next: () => Promise<unknown>) => Promise<unknown>;

  /** 可选配置快照（用于调试/面板展示） */
  config?: Record<string, unknown>;
}

interface ToolContext {
  toolName: string;
  input: any;
  parameters: z.ZodTypeAny;
  description: string;
  metadata: {
    agentId: string;
    sessionId?: string;
    traceId?: string;
  };
  readonly definition: ToolDefinition;
}
```

**内置模型中间件：**

- **限流**：来自 `@rejelly/limit-model`，提供 **`withLimit(options)`**（Rule 级、store 可插拔）与 **`withSimpleLimit(options)`**（rpm/tpm/concurrency 简化封装）。

```typescript
import { augmentModel } from '@rejelly/core';
import { withSimpleLimit } from '@rejelly/limit-model';

const limitedModel = augmentModel(baseModel, [
  withSimpleLimit({ rpm: 60, tpm: 90000, concurrency: 5, key: 'my-model' }),
]);
```

完整 API（`withLimit` 的 Rule 类型、MemoryStore / RedisStore 选型与多进程警告、Redis Cluster hash tag、多租户示例、错误类型）见 [Limit Model (限流)](/zh/api/limit-model)。

**AgentMiddleware 接口：**

```typescript
interface AgentMiddleware<Props = unknown, Result = unknown> {
  /** 中间件名称（用于调试和日志） */
  name: string;

  /** 中间件处理函数 */
  handler: (
    ctx: AgentMiddlewareContext<Props>,
    next: () => Promise<Result>
  ) => Promise<Result>;
}

interface AgentMiddlewareContext<Props = unknown> {
  /** Agent ID */
  agentId: string;
  /** Agent 调用时的 props */
  props: Props;
}
```

> **⚠️ AgentMiddleware 执行时机与幂等性**
>
> `AgentMiddleware` 在 **ctx 创建完成之后、handler 执行之前** 运行。  
> 在 reborn 场景下会按 generation **重复执行多次**，因此中间件内不要放置非幂等、或明确禁止重复执行的任务（例如一次性扣费、不可重入外部写操作等），除非你自行做去重/幂等保护。

**工具中间件执行顺序：**

当工具同时有静态中间件（通过 `augmentTool` 添加）和动态中间件（通过 `equipTool` 添加）时，执行顺序为：

```
Dynamic (outer) → Static (middle) → Handler (inner)
```

这样设计的原因：
- 静态中间件（如重试）应该更接近 handler，避免网络抖动导致动态中间件（如内存写入）重复执行
- 动态中间件可以访问 Agent 上下文（内存、作用域等），适合业务逻辑

> **⚠️ 按「能否被安全重放」分层（隐式契约，务必照此放置）**
>
> 这条顺序的真正依据不是「谁先定义」，而是**幂等性**：会**重放**的逻辑必须在最内、只包住可重放的 handler；带**不可重入副作用**的逻辑必须在外、待在重放圈之外。据此：
>
> - **重试 / 退避 / 熔断等可重放逻辑 → 放 `augmentTool` 静态层（内）**。这样一次抖动只 replay handler 本身，不会连带重跑外层副作用。
> - **扣费 / 写内存 / 计数 / 写日志等不可重入副作用 → 放 `equipTool({ middleware })` 动态层（外）**，每次逻辑调用只执行一次。
>
> 反过来把重试塞进动态层（外），会让一次网络抖动把内层所有副作用**重复触发**（重复扣费、丢更新等）。层的命名（static/dynamic）本身不暗示这条约定，放错不会报错，请按上述对应关系放置。

**Agent 中间件执行顺序：**

Agent 中间件采用洋葱模型，从右到左组合，从外到内执行：

```
Middleware[0] (outer) → Middleware[1] → ... → Handler (inner)
```

中间件可以访问 Agent ID 和本次调用的 props，适合实现日志、监控、权限检查等功能。

## `promptAgent(schema)`

执行 LLM 调用，返回符合 schema 定义的输出结果，自动类型推断。

**Generation 与一次 promptAgent：** **Generation** 指 Agent 的一次执行轮次：框架在每次进入 handler 前会开启一轮新的 Generation（reborn 循环中的一轮），重置 draft（equip/expect 等），在本轮内收集所有 equip/expect 后发起一次 LLM 调用。因此**每个 Generation 只能调用一次 `promptAgent()`**；若在一次 handler 内多次调用 `promptAgent()`，后续调用会抛出 `PromptAgentAlreadyCalledError`。需要多次 LLM 调用时，应通过 `reborn` 拆成多轮（每轮一个 Generation、一次 `promptAgent()`）。

> **⚠️ 关键规则：调用顺序约束**
> 
> **必须在 `promptAgent()` 之前调用的函数**（在同一 Generation 内若违反顺序，会抛出 `AfterPromptAgentError`）：
> 
> - `equipSystem()` - 必须在 promptAgent 之前
> - `equipInstruction()` - 必须在 promptAgent 之前
> - `equipTool()` - 必须在 promptAgent 之前（例如 MCP 的 `kit.inject()` 内部会调用 `equipTool`，同样受此约束）
> - `equipToolCallLoopMiddleware()` - 必须在 promptAgent 之前（注册「工具执行前」循环中间件，与拼 Prompt 的 draft 同属一轮 barrier）
> - `equipBudget(config)` - 必须在 promptAgent 之前
> - `expectValidator()` - 必须在 promptAgent 之前
> - `onStream()` - 必须在 promptAgent 之前
> 
> **不需要在 `promptAgent()` 之前调用的函数：**
> 
> - `equipMemory()` / `equipMemo()` - 绑定 **Agent 级** `ctx.memory`（纯内存，随单次 Agent invocation 存活、跨 reborn，Agent 返回即销毁；跨 Agent / 跨 Session 用 `runWith({ providers })` 注入真实持久化客户端并通过 `expectResource()` 读取），可在本 Generation 内任意时刻调用（含首次注册新 key、含 promptAgent 之后），用于跨 reborn 保留与读写状态；**不**受 `AfterPromptAgentError` 约束（与用于拼 Prompt 的 draft equip 不同）
> - `equipScope()` - 必须在调用子 Agent 之前（与 promptAgent 无关）
> - `expectScope()` - 可在任何位置调用（用于读取父 Agent 提供的作用域）
> - `expectResource()` - 可在任何位置调用（用于读取父 Agent 暴露的资源）
> 
> **原理**：
> - **promptAgent 相关**：框架在调用 `promptAgent()` 时收集所有已配置的、参与拼 Prompt 的 draft（如 system/instruction/tools/expect/onStream 等），构建完整的 Prompt 并发送给 LLM。在 `promptAgent()` 之后若仍调用上述「必须在之前」列表中的 API（违反顺序），会直接抛出 `AfterPromptAgentError`。`equipMemory` / `equipMemo`（基于 memory）、`expectScope` / `expectResource`（读取依赖，非 draft）不参与该 barrier。
> - **子 Agent 相关**：`equipScope()` 用于为子 Agent 提供作用域，必须在调用子 Agent 之前调用，与 `promptAgent()` 无关。
> - **读取依赖**：`expectScope()` 和 `expectResource()` 用于读取父 Agent 提供的作用域和资源，可以在任何位置调用（包括 promptAgent 之后）。
> - **依赖数组比较**：`equipMemo` 使用**深比较**（便于 config、params 等内联对象，减少样板代码）；`equipResource` 使用**浅比较（React 风格）**，其 **`deps` 允许包含不可序列化的值**（类实例、闭包、带符号的引用等，与 `equipMemo` 的纯数据取向不同；适用于不可序列化、有副作用的实体）。详见 [Equip（输入与上下文）](/zh/api/equip)。

**调用顺序示例：**

```javascript
handler: async (props) => {
  // ============ 1. 装备阶段（必须在 promptAgent 之前）============
  equipSystem('你是一个助手');
  equipInstruction('回答问题');
  const [state, setState] = equipMemory('history', []);
  
  // ============ 2. 期望阶段（必须在 promptAgent 之前）============
  // 可以使用 expectValidator 验证 LLM 输出
  expectValidator((data) => {
    if (!data.answer || data.answer.length < 10) {
      return '回答太短，请详细一些';
    }
    return true;
  });
  
  // 可以使用 onStream 监听 Agent 级流事件
  onStream(async (stream) => {
    for await (const event of stream) {
      if (event.type === 'structured_data') {
        console.log('结构化流式结果:', event.status, event.data);
      }
    }
  });
  
  // ============ 3. 调用 LLM ============
  // promptAgent(schema) 直接定义结构化输出并自动类型推断
  const output = await promptAgent(z.object({ answer: z.string() }));
  
  // ============ 4. 业务逻辑处理（promptAgent 之后）============
  // ❌ 不能再调用会拼进本轮 Prompt 的 equip/expect/onStream（会抛 AfterPromptAgentError）
  // equipInstruction('补充说明'); // ❌ AfterPromptAgentError
  // expectValidator(...); // ❌ AfterPromptAgentError
  // ✅ equipMemory 仍可读写（例如记结果、计数）
  // const [n, setN] = equipMemory('post_prompt_count', 0);
  
  // ✅ 可以进行业务逻辑验证（使用普通 if 判断）
  if (someBusinessCondition) {
    return reborn(); // 重新执行 handler
  }
  
  return output;
}
```

**注意区分**：
- `expectValidator` - 验证 **LLM 输出**，必须在 promptAgent 之前
- 业务逻辑验证 - 验证 **handler 最终结果**，用普通 if 判断，在 promptAgent 之后

## `onStream(consumer, options?)`

监听当前 Generation 内的 Agent 级流事件。`onStream` 不是直接暴露底层 `ModelAdapter.stream()` 的原始事件，而是在 policy / turn / tool loop 之上提供一个更高层的多播流。

**必须在 `promptAgent()` / `promptChat()` 之前调用**；否则抛出 `AfterPromptAgentError`。

**函数签名：**

```typescript
onStream(
  consumer: (stream: AsyncGenerator<AgentStreamEvent>) => void | Promise<void>,
  options?: {
    signal?: AbortSignal;
    awaitOnEnd?: boolean; // 默认 true
  }
): void;
```

**`options` 说明：**

- `signal`：用户自定义取消信号；与当前 Generation 的内部 signal 合并，任一方 abort 都会结束该 consumer。
- `awaitOnEnd`：是否在当前 Generation 结束时等待该 consumer 自己完成收尾逻辑。默认 `true`；为 `true` 时，框架会在 Generation 收口时等待该 consumer 的 Promise 结束。纯 UI fire-and-forget consumer 可显式设为 `false`。

**生命周期语义：**

- `onStream` 绑定在**当前 Generation** 上，不跨 reborn 复用。
- consumer 会在 `promptAgent()` / `promptChat()` 跨过 draft barrier 后启动；即使后续一条流事件都没有（例如模型调用立即失败），consumer 也会收到结束信号，`finally` 仍会执行。
- 当前 Generation 结束时（正常返回、抛错、取消、reborn），框架会主动关闭该 Generation 的 stream。
- **没有 Generation 级别的“流结束”事件，这是刻意的。** generator 结束本身就是这个信号；每个 turn 则由 `turn_done` 标记边界。Generation 关闭流以及任一 signal 取消时，循环都会正常退出。生产侧失败通过 `error` 事件送达，不会使 generator 抛出；consumer 自己的代码仍可能抛错，因此必须在所有路径上执行的清理应放在包住循环的 `finally` 里。

**事件模型：**

```typescript
type AgentStreamEvent =
  | { type: 'turn_start'; turnIndex: number }
  | {
      type: 'text';
      turnIndex: number;
      delta: string;
    }
  | { type: 'reasoning'; turnIndex: number; delta: string }
  | {
      type: 'structured_data';
      turnIndex: number;
      status: 'partial' | 'complete' | 'error';
      data: Partial<unknown>;
      isValid: boolean;
    }
  | { type: 'tool_call_stream'; turnIndex: number; chunk: ToolCallChunk }
  | { type: 'tool_call'; turnIndex: number; toolCall: ToolCall }
  | { type: 'usage'; turnIndex: number; usage: TokenUsage }
  | { type: 'extra'; turnIndex: number; extra: Record<string, unknown> }
  | {
      type: 'turn_done';
      turnIndex: number;
      finishReason: FinishReason;
    }
  | { type: 'error'; turnIndex: number; error: unknown };
```

**关键事件说明：**

- `turn_start`：一轮 prompt turn 开始；适合清理上一轮的局部 UI 状态。
- `text`：正文文本增量；工具参数流使用独立的 `tool_call_stream` 事件。
- `structured_data`：当前文本缓冲区的结构化解析结果。
  - `status: 'partial'`：流尚未结束，当前是中间态。
  - `status: 'complete'`：流已结束，最终结构化结果有效。
  - `status: 'error'`：流已结束，但最终结构化结果无效或不完整。
  - 未提供 schema 时，只有文本被成功识别为 JSON 对象才会发出快照；普通文本不会产生解析失败噪音。
- `tool_call_stream`：底层工具调用 chunk，保留原始分片。一次调用会流出多个 chunk，它们共享同一个 `chunk.index`。
- `tool_call`：框架已把 chunk 合并成完整 `ToolCall`。它在本 turn 的 `turn_done` 之前、工具开始执行之前发出。
- `extra`：适配器/模型返回的额外元数据。
- `turn_done`：本 turn 的最后一个流事件，携带适配器的 `finishReason`（成功结束但适配器未提供时为 `unknown`）；此时最终快照与完整调用均已就绪，但工具尚未开始执行。

**单个 turn 内的事件顺序：**

适配器报告 `finish` 时，框架会先保留其 `finishReason`；只有在完整消费适配器流并准备好所有派生事件后，才发出 `turn_done`：

```
turn_start → text / reasoning / structured_data(partial) / tool_call_stream …
  → structured_data (complete|error)   ← 权威的解析结果
  → tool_call × n                      ← 装配完成的调用
  → turn_done                          ← 本 turn 的最后一个事件
  → （工具执行，然后是下一个 turn_start）
```

consumer 可以安全地把 `turn_done` 当成本 turn 的汇总点：此时本轮所有 `tool_call` 均已发出，工具尚未开始执行。

**常见 UI 策略：先输出 `text`，一旦收到 `structured_data` 就停掉本 turn 后续的普通 `text`。**

原因是两者通常来自同一段模型输出，`structured_data` 往往会覆盖同一内容的结构化视图；继续同时渲染容易重复。

**示例：**

```typescript
handler: async () => {
  onStream(
    async (stream) => {
      let sawStructuredData = false;
      for await (const event of stream) {
        switch (event.type) {
          case 'turn_start':
            sawStructuredData = false;
            resetTurnUI(event.turnIndex);
            break;
          case 'text':
            if (!sawStructuredData) {
              appendPlainText(event.delta);
            }
            break;
          case 'structured_data':
            sawStructuredData = true;
            renderForm(event.data, {
              status: event.status,
              isValid: event.isValid,
            });
            break;
          case 'tool_call':
            console.log('完整工具调用:', event.toolCall);
            break;
          case 'turn_done':
            finishTurn(event.turnIndex, event.finishReason);
            break;
        }
      }
    },
    { awaitOnEnd: true },
  );

  return await promptAgent(z.object({ answer: z.string() }));
};
```

## `promptChat()`

执行标准对话策略，返回模型最终文本与本轮新增消息。


**与 `promptAgent(schema)` 的区别：**

- `promptChat()` 返回 `{ data: string, delta: Message[] }`，其中 `data` 是最终文本，`delta` 是本轮可用于持久化追加的新增消息。
- `promptChat()` 走 chat policy 的多轮工具循环；`promptAgent(schema)` 面向结构化输出。
- `promptChat()` 同样依赖本轮已 equip 的 system/instruction/tools。

**工具循环规则：**

- 预设 policy **不设置** `toolChoice`（模型按默认策略自行决定是否调工具）；需要「强制用工具」请编写自定义 policy，用 `executeTurn({ toolChoice })` 控制每个 turn。generation 级参数（temperature 等）在构造 model adapter 时配置。
- 每轮若返回 `tool_calls`，会先追加 assistant 消息，再执行工具并把 tool 消息写回对话，继续下一轮。

**终止与异常：**

- 当模型返回普通内容且通过 validator 校验时结束，并返回 `{ data, delta }`（若 content 非字符串，按空字符串处理）。
- 达到 `maxTurnSteps` 仍未得到内容时，抛出 `ToolLoopExceededError`（与之独立的 `TurnBudgetExceededError` 是 `executeTurn` 层的总预算护栏，校验重试也计入，详见 [Policy - 两层 turn 预算](policy.md#两层-turn-预算)）。

## `dumpSnapshot()`

导出当前 Agent 执行状态的快照，用于持久化和后续重放。API 从 `@rejelly/core/debugger` 引入。用法、返回值与注意事项见 [时间旅行 (time-travel.md)](./time-travel.md#dumpSnapshot)。

## `runWith(fn, options?)`

在顶层执行函数；可选传入快照以恢复上下文。无快照时直接执行；有快照时从快照恢复根上下文后再执行。快照恢复、重放机制及完整示例见 [时间旅行 (time-travel.md)](./time-travel.md#runWithfn-options-与快照)。

```typescript
import { runWith } from '@rejelly/core';

// 正常执行（无快照）
const result = await runWith(async () => {
  const agent = createAgent({ ... });
  return await agent({ input: 'test' });
});

// 使用快照恢复执行（snapshot 从 @rejelly/core/debugger 的 dumpSnapshot 或 restoreSnapshot 获得）
const resultFromSnapshot = await runWith(async () => { ... }, { snapshot });

// 与外部取消源绑定（例如 HTTP Request、UI 上的「停止」）：abort 后根上下文的 signal 同步进入 aborted，后续模型调用与可取消工具会收到
const ac = new AbortController();
const resultWithSignal = await runWith(
  async () => {
    const agent = createAgent({ ... });
    return await agent({ input: 'test' });
  },
  { signal: ac.signal },
);
// 在别处调用 ac.abort() 即可取消本次 run 链路上的异步工作
```

**函数签名：**

```typescript
export function runWith<R>(
  fn: () => Promise<R>,
  options?: RunWithOptions<void>
): Promise<R>;

export function runWith<P, R>(
  fn: (props: P) => Promise<R>,
  options?: RunWithOptions<P>
): Promise<R>;

interface RunWithOptions<P = unknown> {
  /** 初始 props，会传入 fn */
  initialProps?: P;
  /** 注入快照用于上下文恢复；若提供则从快照恢复根上下文后再执行 */
  snapshot?: AgentSnapshot;
  /** 自定义 trace 事件发射器；只要求实现 emit(event) */
  eventBus?: TraceEventEmitter;
  /** 根注入依赖；可通过 expectResource(key) 读取 */
  providers?: Record<string, unknown>;
  /** 根 context 的模型适配器（链上未指定 model 的 Agent 可就近继承） */
  model?: ModelAdapter;
  /** 模型注册表：id -> ModelAdapter。注入到根 context 的 shared.modelRegistry，链上 Agent 的 model 为 string 时在此解析 */
  modelRegistry?: Record<string, ModelAdapter>;
  /** 是否开启快照（默认 IS_DEV）；未开启时 dumpSnapshot 会抛错，recordJournal/saveChildFrame 直接 return */
  enableSnapshot?: boolean;
  /** 分布式追踪：traceId、parentSpanId、全局 attributes */
  trace?: { traceId?: string; parentSpanId?: string; attributes?: Record<string, unknown> };
  /** 可选；与根上下文 AbortSignal 联动（如请求取消、用户中止）。外部 abort 时根 context 的 signal 会以相同 reason 进入 aborted */
  signal?: AbortSignal;
}
```

**简要说明：**

- **无快照**：直接执行 `fn`，不恢复上下文。
- **有 snapshot**：从快照根帧恢复根上下文（内存、重放缓存等），再执行 `fn`；子 Agent 会从 `snapshot.children` 自动恢复。
- **modelRegistry**：id → ModelAdapter 的字典，注入到根 context 的 `shared.modelRegistry`，链上共享。Agent 的 `model` 为 string 时在运行期由此解析；id 不存在时抛出 `ModelRegistryNotFoundError`。
- **enableSnapshot**：默认 `IS_DEV`（开发/测试为 true）。为 false 时不记录 journal、不保存子帧，且 `dumpSnapshot()` 会抛错；详见 [时间旅行 - enableSnapshot](./time-travel.md#时间旅行-time-travel)。
- **signal**：传入的 `AbortSignal` 会挂接到根 `createAgentContext`：外部一旦 `abort`，根上下文的 `controller` 会收到相同 reason，`ctx.signal` 进入 aborted；子 Agent 仍按原有规则级联父级 signal。适合与 HTTP `Request.signal`、前端停止按钮等取消源对齐。

**与 `enableReview()` 的配合：**

- 若需要将 Trace 实时上报到 Review Server，可在应用启动阶段调用 `enableReview()`（API 见 [debug.md](./debug.md#review-exporter)）；它与 `runWith()` 不冲突，`runWith` 内产生的 trace 事件会自动进入已启用的 Review exporter。
- 在 Next.js / Vite HMR / 本地热更新场景下，模块初始化代码可能被重复执行，导致 `enableReview()` 被重复注册，从而出现**重复上报**。接入方应自行做**一次性注册 / 幂等保护**（例如挂到 `globalThis` 的 symbol 标记上，只启用一次）。

## `restoreSnapshot(trace, options?)`

从线性事件追踪（TraceEvent[]）恢复 AgentSnapshot，实现时间旅行。API 从 `@rejelly/core/debugger` 引入。签名、anchor 模式、使用示例与错误处理见 [时间旅行 (time-travel.md)](./time-travel.md#restoreSnapshottrace-options).
