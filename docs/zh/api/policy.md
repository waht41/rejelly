# Policy

`promptChat` 和 `promptAgent` 是同一个 tool-call-loop policy 的两个预设变体。
它们不是两套独立的执行引擎，而是基于更底层的原语组合出来的便捷策略。

这些底层原语包括：

- `executeTurn`：执行一次模型调用。
- `executeTools`：执行模型返回的 tool calls。
- `executeValidation`：解析模型输出（可选传入 `OutputParser`），并执行通过 `expectValidator` 注册的校验器，同时上报 validation 遥测事件。

三者均由 `@rejelly/core/policy` 导出，扩展 policy 应基于它们组合，而不是复制预设实现。

三个原语都是 **policy 内部专用**的：它们只接受由当前 policy 的
`PromptContext` 派生出来的 runtime（见下文 [Runtime Seal](#runtime-seal)），
在 agent handler 里裸调会抛 `InvalidPromptRuntimeError`。需要在预设 policy 之外做模型调用时，
逃生舱是**再写一个小的自定义 policy**，而不是绕过 policy 边界。

## 基本模型

Policy 是 agent handler 和执行原语之间的组合层。

自定义 policy 通过公开的 `createAgentPolicy` 工厂创建。

Policy 工厂负责处理通用的 prompt 生命周期：

- 读取当前 agent context。
- 限制每次 run 只能调用一次 prompt policy。
- 把 draft 冻结成 base `PromptContext`（包含 `messages`、system、instruction、tools、tool loop middleware 等）。
- 创建 prompt 级别的 telemetry span 和事件。
- 调用具体 policy handler。
- 上报成功或失败的结果元数据。

具体的 policy handler 则负责决定如何组合 `executeTurn`、`executeTools`、解析、
校验、重试和循环逻辑。

## Tool-Call-Loop Policy

共享的预设循环是 `runToolCallLoopPolicy`。

它的流程是：

1. 从 base `PromptContext` 读取初始 `messages`。
2. 为当前 history `ctx.fork({ messages })`，并用该 runtime 调用 `executeTurn`。
3. 如果模型返回 content，则执行解析和校验。
4. 如果校验失败，把错误反馈追加到本轮临时对话中，并在同一个 turn step 内重试。
5. 如果模型返回 tool calls，则用同一个 runtime 视图通过 `executeTools` 执行工具。
6. 把 assistant message 和 tool output message 追加到 history，然后继续下一轮。
7. 如果超过 `maxTurnSteps`，抛出 `ToolLoopExceededError`。

### 两层 turn 预算

`maxTurnSteps` 在两个层面生效，对应两个**相互独立**的错误类型（刻意不做继承——失败词汇表属于各自层的观点，且两者的 `actualTurns` 度量的不是同一个量）：

- **Engine 护栏（`TurnBudgetExceededError`）**：`executeTurn` 自身维护本 Generation 的模型调用总数（**校验重试也计入**，`actualTurns` 即该计数），达到 `maxTurnSteps` 时直接抛出。它与具体 policy 无关，是防扩展 policy 死循环、重试风暴的安全网；对 graph/ToT 类 policy 而言即「每 Generation 的节点预算」。
- **Tool loop 不收敛（`ToolLoopExceededError`）**：预设 tool-call-loop policy 的失败观点——模型在 `maxTurnSteps` 轮内一直返回 tool calls、始终没有产出最终 content（`actualTurns` 为 loop 轮次，一轮内的校验重试只算一次）。调大 `maxTurnSteps` 的建议只对这一层成立。

需要把「turns 用完」统一处理时，组合两个类型守卫：`isTurnBudgetExceededError(e) || isToolLoopExceededError(e)`。

`executeTurn` 可以在同一个 policy 内被 `Promise.all` 等方式并发调用；每次调用会在第一次
`await` 之前同步占用一个 turn slot，因此并发分支共享同一个 Generation 的
`maxTurnSteps` 预算，不会因为 fan-out 而绕过 engine 护栏。

扩展 policy 可通过 `PromptContext.usedTurnSteps`（实时值，含校验重试）与
`maxTurnSteps` 对比，在 fan-out 前判断剩余预算并优雅降级（例如缩小 beam width），
而不是撞上 engine 护栏后中途失败。

这样 tool loop 行为可以复用，而不同的公开 prompt API 只需要定义自己的入参和返回值形状。

## Base Runtime 与 Fork

执行原语（`executeTurn` / `executeTools`）消费的是一个 **runtime 快照**：`messages`、system、instruction、tools、tool loop middleware 等「本次模型调用和后续工具执行要用到的数据」。

策略入口收到的 `PromptContext` 就是 base runtime（加上 `fork()`、budget、`span` 等执行面）。它在 policy 入口由 draft 冻结一次得到。之后不要再把 draft 当作配置来源；需要不同节点、不同分支、不同工具集时，从 base runtime 派生 fork。

这是同一次 agent run 内的阶段边界：

1. **装载阶段（Equip Phase）**：agent handler 调用 `equipSystem`、`equipInstruction`、`equipTool`、`expectValidator` 等，收集本 generation 的 draft。
2. **策略入口（Policy Barrier）**：调用 `promptAgent`、`promptChat` 或扩展 policy。`createAgentPolicy` 跨过 barrier，把 draft 冻结成 base `PromptContext`。
3. **策略执行阶段（Policy Execution）**：policy 消费 base runtime。需要不同 message history、工具集或 tool loop middleware 时，通过 `ctx.fork(...)` 派生局部 runtime，再把它显式传给执行原语。

早期可以把这个过程理解成 **load before consume**；更精确的模型是：handler 装载 base runtime，policy 执行时 fork runtime。

策略执行阶段遵守以下 runtime 契约：

1. **单一来源**：`runtime` 是 `executeTurn` / `executeTools` 的**必传**参数，tools、tool loop middleware、loop history 全部从它读取。早期「不传 runtime 时回退活 draft」的兼容行为**已删除**——那条回退正是让 handler 裸调原语「看起来能跑」的根因（draft 未冻结、校验器被静默跳过、turn span 游离在 prompt span 之外）。
2. **早绑定**：base `PromptContext` 在 policy 入口冻结。generation 进行中再 `equip*` **不会**回灌到已 fork 的 runtime——配置请在调用 prompt policy 之前完成。
3. **fork 共享 generation 全局态**：turn 预算（`maxTurnSteps` / steps 计数）、journal、`span`、abort signal 都挂在底层 `AgentContext` 上、由所有 fork **按引用共享**。因此并发 fan-out 时各分支 fork 出不同的 messages/tools，**不会分裂预算、也不会丢缓存**（与上文「两层 turn 预算」一致）。`fork()` 只覆盖 runtime 视图字段，绝不拷贝这些全局态。
4. **offered == executed 是你的责任**：把**同一个** runtime 同时喂给 `executeTurn` 和 `executeTools`，模型被提供的工具集才等于执行器实际认账的工具集。给两者传不同 tools 会让「模型看到的」与「能执行的」错位。
5. **messages 也属于 fork**：conversation history 不再是散落在 policy 局部变量里的“外部参数”。每次 turn 前把当前 history 放进 fork：`const turnRuntime = ctx.fork({ messages })`。工具执行时也用这个 runtime 的 `messages` 作为 history。

### Runtime Seal

「原语只能在 policy 执行阶段使用」不是文档约定，而是运行时强制的。机制是**能力对象（capability）**而非环境标记：

- policy barrier（`createAgentPolicy`）在冻结 base `PromptContext` 时，为**本次 policy 执行**创建一个 seal，以隐藏属性（symbol 键）附着在 runtime 上。symbol 键不进入 `Object.keys` / JSON 序列化，因此 seal 永远不会泄漏进 trace 或快照。
- 所有 `fork()` 按**引用**共享同一个 seal——与 turn 预算、journal 等 generation 全局态的共享方式同构（见上文第 3 条）。
- policy handler 返回或抛错时，seal 在 barrier 的 `finally` 中失效，**所有 fork 一并作废**。runtime 不能比它的 policy 活得更久。

三个原语都在入口校验 seal——`executeTurn` / `executeTools` **先于**消耗 turn 预算，
`executeValidation` **先于**打开 validation span 与写 `validationRan` 标志。四种拒绝路径对应
`InvalidPromptRuntimeError` 的 `reason` 字段（配套类型守卫 `isInvalidPromptRuntimeError`，
`apiName` 标明是哪个原语拒绝的）：

| `reason` | 场景 |
|---|---|
| `missing` | 没传 runtime（只有无类型的 JS 调用方能走到；TS 下是编译错误） |
| `unsealed` | 手工构造的 runtime 对象，不是从 policy 的 `PromptContext` 派生的 |
| `expired` | 所属 policy 已经返回/抛错——包括把 `PromptContext` 存进外部变量、在 handler 里事后裸调 |
| `foreign` | seal 还活着，但 runtime 属于另一个 generation——例如经闭包走私进子 Agent 的 handler |

对 `executeValidation` 而言，`runtime` 是纯**能力凭证**：它照旧从 draft 读取 `expectValidator`
注册的校验器，不从 runtime 读任何数据。强制凭证的原因是簿记安全——`executeValidation` 会置位
`validationRan`，而这正是 policy barrier 判断「validator 契约被绕过」警告（见下方 ⚠️ 块）的唯一依据；
若 handler 能裸调它（例如被当成通用校验工具误用一次），这张兜底网就会被无声拆掉。

一个边界语义：对 runtime 做对象展开（`{ ...runtime, tools: [...] }`）会随 symbol 属性带走**同一个** seal 引用，因此仍会被放行——它在语义上就是同一次 policy 执行的派生视图。但推荐统一用 `fork()`，它还会正确处理数组拷贝与函数式覆写。

被 seal 拒绝**不代表你的需求不合法**，只代表位置不对：想在 `promptAgent` / `promptChat` 之外做模型调用（预检分类、路由、graph 节点……），写一个内联的自定义 policy 即可——`createAgentPolicy` 的成本只有几行（见下方骨架），换来 prompt span、stream runtime、`expectValidator` 契约和生命周期全部保留。多次独立的 LLM 调用则用 `reborn` 拆成多个 generation，或下沉给子 Agent。手动执行单个工具（不经过模型 tool-call 循环）不受此限制，走 `callTool`。

`PromptContext.fork()` 可以派生这些 runtime 字段：

```ts
const nodeRuntime = ctx.fork({
  messages: [...ctx.messages, { role: "user", content: "node prompt" }],
  tools: [searchTool, citeTool],
  toolCallLoopMiddlewares: [],
});
```

模型调用选项不是 runtime 字段；它们属于每次 `executeTurn` 调用：

```ts
const { message } = await executeTurn(nodeRuntime.messages, {
  runtime: nodeRuntime,
  toolChoice: "auto",
  additionalOptions: { temperature: 0 },
});
```

一个最小 tool loop policy 骨架如下：

```ts
import {
  createAgentPolicy,
  executeTools,
  executeTurn,
  executeValidation,
} from "@rejelly/core/policy";
import type { Message } from "@rejelly/core";

export const myPolicy = createAgentPolicy({
  policyId: "my-policy",
  handler: async (ctx) => {
    const messages: Message[] = [...ctx.messages];
    const delta: Message[] = [];

    while (ctx.usedTurnSteps < ctx.maxTurnSteps) {
      const runtime = ctx.fork({ messages });
      const { message } = await executeTurn(runtime.messages, { runtime });

      if (message.tool_calls?.length) {
        messages.push(message);
        delta.push(message);

        const toolRuntime = ctx.fork({ messages });
        const toolMessages = await executeTools(message.tool_calls, {
          runtime: toolRuntime,
        });
        messages.push(...toolMessages);
        delta.push(...toolMessages);
        continue;
      }

      const rawText = typeof message.content === "string" ? message.content : "";
      const validation = await executeValidation(rawText, { runtime });
      if (!validation.success) {
        throw new Error(validation.errors.join("\n"));
      }
      delta.push({ ...message, content: validation.data as string });
      return { data: validation.data, delta };
    }

    throw new Error("Policy did not converge before maxTurnSteps.");
  },
});
```

> 流式调用参数不属于 runtime：`toolChoice` 是 `executeTurn({ toolChoice })` 的 per-turn 参数，temperature 等 provider 选项通过 `executeTurn({ additionalOptions })` 按单 turn 覆盖。预设 tool-call-loop policy 刻意不设置 `toolChoice` 或 `additionalOptions`；需要这些控制时，在扩展 policy 中直接组合 `executeTurn`。

## 语法糖：`executeValidatedLoopTurn`

原语只有三个（`executeTurn` / `executeTools` / `executeValidation`）。上面骨架里「调用一次模型 → 若返回 content 就校验、失败就在**同一 turn step 内**追加反馈重试；若返回 tool calls 就交回外层循环执行」这段簿记，几乎每个 tool-call-loop policy 都要重写一遍。`executeValidatedLoopTurn` 把它固化成一个导出的**语法糖**——就像 `equipMemo` 之于 `equipMemory`：它复用原语、封装重试计数与 `AttemptsExhaustedError`，但**不是第四个原语**，原语词汇表仍然是三个。

```ts
import { executeValidatedLoopTurn, type LoopTurnResult } from "@rejelly/core/policy";

const result: LoopTurnResult = await executeValidatedLoopTurn({
  runtime: ctx.fork({ messages }),
  jsonSchema,          // 可选：结构化输出
  parser,              // 可选：不传即纯文本路径（validators 仍然运行）
  maxRetries: ctx.maxRetries,
});

if (result.kind === "content") {
  // 已通过 executeValidation 的最终结果 + 本 step 的 delta 消息
  return { data: result.data, delta: result.deltaMessages };
}
// result.kind === "tool_calls"：把 result.calls 交给 executeTools，外层循环继续
```

它的返回类型 `LoopTurnResult`（`content | tool_calls` 判别联合）是**刻意 loop 形状**的：预设 `runToolCallLoopPolicy` 和 evil-jelly 的 resilient chat policy 都直接复用它，差异只落在**外层循环**（如何执行工具、control tool、abort 收尾、pendingUserInput 注入等真实产品行为）。

两个分支**都**携带 `deltaMessages`（本 step 新增的全部消息），只有各自的可执行载荷不同（`content` 给 `data`，`tool_calls` 给 `calls`）。外层因此可以统一先 `push(...result.deltaMessages)` 再按 `kind` 分流。这一点很关键：一次校验重试若在追加了「失败输出 + 反馈」后**转而返回 tool calls**，这些 step 内消息也会随 `deltaMessages` 一起交回，不会丢失（否则记录的对话历史会与模型实际看到的错位）。

这也划清了适用边界：需要**不同的 delta 整形或重试语义**时，别去给这块糖加参数——直接下沉到三个原语自己组合，正如需要自定义缓存策略时改用 `equipMemory` 而非 `equipMemo`。糖是便利，不是唯一入口。

## 预设变体

### `promptAgent(schema)`

`promptAgent` 是结构化输出变体。

它会：

- 直接接收 Zod schema。
- 把 Zod schema 转换成 JSON Schema，传给模型调用。
- 使用 JSON output parser 做解析和校验。
- 只返回校验后的结构化数据。

这个变体适合 agent handler 需要 typed final result 的场景。

### `promptChat(options)`

`promptChat` 是 chat 变体。

它会：

- 通过 `options.message` 接收额外 message。
- 可选接收 `options.schema`。
- 返回 `{ data, delta }`。
- `delta` 只包含本次 loop 新产生的消息，例如 assistant message、tool output 和校验反馈。

没有 schema 时，`data` 是校验后的 raw text。
有 schema 时，`data` 是解析后的结构化值。

## Policy 扩展

扩展 prompt 行为也应该遵循同样的模式：

1. 使用 `createAgentPolicy` 接入 agent context、生命周期限制和 telemetry。
2. 从传入的 `PromptContext` 出发，用 `ctx.fork(...)` 派生每个 turn/node 的 runtime。
3. 按需组合 `executeTurn`、`executeTools`、`executeValidation` 等执行原语。
4. 在 policy 内部添加解析、校验、重试或 tool loop 行为。
5. 把公开 API 的入参和返回值形状放在 policy 边界上，而不是塞进底层原语。

这样可以让核心执行原语保持简单、可复用，同时由 policy 定义面向应用层的产品行为。
反过来说，policy 也是使用原语的**唯一**位置：在 handler 里绕过
`createAgentPolicy` 直接调 `executeTurn` / `executeTools` / `executeValidation` 会被
[Runtime Seal](#runtime-seal) 拒绝。哪怕只是一次性的模型调用，也请包成一个内联小 policy——成本是几行样板，收益是
telemetry、校验契约和生命周期不出现盲区。

> **⚠️ Policy 最终内容须经过 `executeValidation`**
>
> `expectValidator()` 是 prompt 阶段的公开契约：Agent 注册的校验器应对**任何** prompt policy 生效。校验器存放在 draft 中，**执行它们的唯一入口是 `executeValidation`**——预设的 `promptAgent` / `promptChat` 内部都会调用它。
>
> 扩展 policy 若直接用 `OutputParser.parse` 解析模型输出（绕过 `executeValidation`），注册的校验器会被**静默跳过**，且 trace / Review 中不会出现 validation 事件。框架会在该 policy 成功返回时检测到这种情况并打印警告（draft 中存在 validators 但本轮从未调用 `executeValidation`）。
>
> 正确用法：对模型返回的最终 content 调用 `executeValidation(rawText, { runtime, parser, attempt })`（`runtime` 必传，与 `executeTurn` 同一套 [Runtime Seal](#runtime-seal) 闸门）。返回 `ValidationAttemptResult`，失败时 `failure` 为 `ValidationFailure`（`failure.type`：`no_content` / `parse_error` / `schema` / `validator`），由 policy 自行决定反馈与重试策略（例如把 `errors` 追加为 user 消息后在同一 turn step 内重试）。若 policy 需要把「模型调用失败」等其它失败也纳入同一套尝试簿记，可自行扩展词汇表（例如 `type AttemptFailure = ValidationFailure | { type: "llm_error" }`）——失败词汇表属于 policy 自己的观点，core 不提供 canonical 版本（`AttemptsExhaustedError.lastFailureType` 是普通 string，自定义词汇表可直接穿过该边界）。`executeValidation` 不传 `parser` 时为纯文本路径：跳过解析，但**仍然**运行 validators——纯文本输出同样受 `expectValidator` 约束。
