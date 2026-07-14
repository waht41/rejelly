# Equip (输入与上下文)

这一阶段负责构建 System Prompt 和 Context Window。

## Prompt 构建

### `equipSystem(text: string)`

插入系统级指令（最高优先级）。多次调用会按顺序拼接到 System Prompt 中。

### `equipInstruction(content: string | ContentPart[])`

插入当前任务指令。多次调用会按顺序拼接，构成完整的任务描述。

支持纯文本（`string`）与多模态内容（`ContentPart[]`，文本与图片混排；`video` 类型已预留、暂未启用）：

```typescript
// 纯文本
equipInstruction('分析以下客户问题：');

// 多模态内容
equipInstruction([
  { type: 'text', text: '请看这张图表：' },
  { type: 'image', image: { url: 'https://example.com/chart.png' } },
  { type: 'text', text: '图中的趋势是上升还是下降？' }
]);
```

## 工具注册

### `equipTool(tool: ToolDefinition, options?: EquipToolOptions)`

注册工具到工具列表中，供 LLM 在对话中调用。

**执行流程：**

1. **工具注册**：使用 `equipTool` 注册工具后，框架会将工具的描述和参数信息（通过模型适配器转换为对应格式，如 OpenAI 的 function calling）传递给 LLM API，告知 LLM 该函数的细节。

2. **工具调用决策**：LLM 在生成回复时，可能会选择调用工具。此时 LLM 可能略过输出 schema，直接执行 tool 调用。

3. **自动执行**：当 LLM 决定调用工具时，框架会自动执行对应的 handler 函数，并将执行结果返回给 LLM。

4. **后续决策**：LLM 会根据 tool 的执行结果判断接下来应该：
   - 继续使用其他工具（如果还需要更多信息）
   - 返回符合 schema 的输出（如果已经收集到足够信息）

**特性：**

- 支持动态中间件（通过 `options.middleware`），用于注入依赖 Agent 上下文的业务逻辑。
- 每次 reborn 后需要重新注册。
- 工具执行是自动的，LLM 可以直接调用，无需手动干预。

**ToolDefinition 接口：**

```typescript
interface ToolDefinition {
  name: string;                    // 工具名称
  description: string;             // 工具描述，告诉 LLM 何时使用
  parameters: z.ZodSchema;         // 参数 Schema（使用 Zod 定义）
  handler: (params: any) => Promise<any>;  // 工具执行函数
  middlewares?: ToolMiddleware[];  // 静态中间件（可选，通过 augmentTool 添加）
}

interface EquipToolOptions {
  middleware?: ToolMiddleware[];   // 动态中间件数组（可选）
}
```

**基本示例：**

```typescript
equipTool({
  name: 'search',
  description: '搜索网络获取实时信息',
  parameters: z.object({
    query: z.string().describe('搜索关键词'),
    limit: z.number().optional().describe('返回结果数量')
  }),
  handler: async ({ query, limit = 10 }) => {
    return await searchAPI(query, limit);
  }
});
```

**带动态中间件的示例：**

```typescript
// 定义基础工具
const BaseSearchTool: ToolDefinition = {
  name: 'search',
  description: '搜索网络获取实时信息',
  parameters: z.object({ query: z.string() }),
  handler: async ({ query }) => await searchAPI(query),
};

// 使用 augmentTool 添加静态中间件（全局复用）
const SafeSearchTool = augmentTool(BaseSearchTool, [
  wrapLog(),            // 日志记录
  wrapRetry({ n: 3 })   // 重试机制
]);

// 在 Agent 中使用，添加动态中间件（依赖上下文）
equipTool(SafeSearchTool, {
  middleware: [
    // 拦截器：将结果同步到 Agent 记忆
    async (ctx, next) => {
      const result = await next();
      const [history, setHistory] = equipMemory('history', []);
      setHistory([...history, `Used ${ctx.toolName}: ${JSON.stringify(result)}`]);
      return result;
    },
    // 拦截器：风控检查
    async (ctx, next) => {
      if (ctx.input.query.length > 100) {
        return "Query too long"; // 阻断执行
      }
      return await next();
    }
  ]
});
```

**外部工具适配器：**

Rejelly 提供了适配器模块，可以将外部工具生态系统集成到 Rejelly 中。详情请参考 [Adapter (适配器)](/zh/api/adapter/) 文档。

### `equipToolCallLoopMiddleware(middleware: ToolCallLoopMiddleware)`

在 **模型已返回本轮 `tool_calls`、尚未执行具体工具** 时介入的一层中间件（在 `equipTool` 的单工具 handler / 动态 `middleware` 之前）。用于过滤调用、鉴权、限流，或对部分调用 **短路** 并返回合成 `ToolOutput[]`（框架再映射为协议层 tool 消息）。

**与 `equipTool` 动态中间件的区别：**

| | `equipToolCallLoopMiddleware` | `equipTool(..., { middleware })` |
|---|------------------------------|----------------------------------|
| 时机 | 整轮 tool calls 执行前（跨工具） | 单个工具即将执行时 |
| 输入 | `ToolCallLoopContext` + `currentCalls` + `next(calls)` | `ToolContext` + `next()` |
| 输出 | `ToolOutput[]`（`callId` + `content`） | 该工具 handler 的返回值 |

**约束：**

- **必须在 `promptAgent()` 之前调用**（与 `equipTool` 同属 draft barrier，否则 `AfterPromptAgentError`）。
- **不得**修改本轮已参与快照的 system / instruction / schema；只读 `ctx`（含 `toolTurns`、`originalCalls` 等）。
- 多层注册时 **先注册为外层**（洋葱），`next(filteredCalls)` 向内传递过滤后的 **`currentCalls`**；`ctx.originalCalls` 始终为模型原始列表。详见 [Core · equipToolCallLoopMiddleware](/zh/api/core#equiptoolcallloopmiddlewaremiddleware)。

**类型摘要：**

```typescript
interface ToolCallLoopMiddleware {
  name: string;
  handler: (
    ctx: ToolCallLoopContext,
    currentCalls: ToolCall[],
    next: (calls: ToolCall[]) => Promise<ToolOutput[]>,
  ) => Promise<ToolOutput[]>;
  config?: Record<string, unknown>;
}
```

### 流式选项归位

旧版通过 equip 写入 draft 的流式选项能力已移除（这是一处 ambient 配置，会被预设 policy 隐式读取、修改）。按生命周期归位到两处：

- **`toolChoice`**（per-turn 指令）：由 `executeTurn(messages, { toolChoice })` 显式传入。预设 policy（`promptChat` / `promptAgent`）**刻意不暴露**它；需要「强制用工具」请编写自定义 policy，自行决定每个 turn 的 `toolChoice`。
- **`additionalOptions`**（temperature、top_p 等 provider 参数）：generation 级参数应在**构造 model adapter** 时配置（一次设定、全程生效）；若要按单个 turn 覆盖，自定义 policy 可用 `executeTurn(messages, { additionalOptions })`，经 `callLLM` 透传到 `model.stream()`。

`StreamOptions` 类型也随之移除；model adapter 接口侧的 `ModelStreamOptions.{toolChoice, additionalOptions}` 保留不变。详见 [Policy 文档](./policy.md)。

### `equipMemory(key, initialVal)`

**核心 Hook**。获取记忆。如果是 `reborn` 导致的重运行，这里会返回上一次修改后的值。

**⚠️ 重要限制**：只能存储 JSON 可序列化的值。

**基本用法：**

```typescript
// 基本用法
const [count, setCount] = equipMemory('counter', 0);

// setState 支持两种调用方式：
setCount(10);                    // 直接设置新值
setCount(prev => prev + 1);      // 函数式更新

// 注意：setCount不会影响已经取出的count
// 如果需要在当前轮次使用新值，需要用局部变量，或者使用equipMemory再次取值
const newCount = count + 1;
setCount(newCount);
equipInstruction(`当前计数：${newCount}`);  // ✅ 使用局部变量
```

**序列化限制：**

`equipMemory` 只能存储 JSON 可序列化的值。

- ✅ **允许的类型**：`string`、`number`、`boolean`、`null`、普通对象（plain object）、数组
- ❌ **禁止的类型**：`function`、`symbol`、`undefined`、类实例（`Date`、`Map`、`Set` 等）、循环引用

```typescript
// ✅ 正确用法
equipMemory('str', 'hello');
equipMemory('num', 42);
equipMemory('obj', { a: 1, b: 'test' });
equipMemory('arr', [1, 2, 3]);
equipMemory('nested', { a: { b: { c: 123 } } });

// ❌ 错误用法（会抛出错误）
equipMemory('fn', () => {});           // function 禁止
equipMemory('date', new Date());        // class instance 禁止
equipMemory('map', new Map());          // class instance 禁止
equipMemory('symbol', Symbol('id'));    // symbol 禁止
equipMemory('undefined', undefined);    // undefined 禁止
```

**行为说明：**

- **作用域与生命周期**：绑定**当前 Agent invocation** 的 `ctx.memory`（纯内存）。它**跨 `reborn` 存活**（同一次 Agent 调用内的多代共享读写），但在 **Agent 返回后随 `ctx` 一起销毁**——不跨 Agent 调用、不跨对话轮次。需要跨 Agent / 跨 Session 持久化时，通过 `runWith({ providers })` 注入真实数据库、Redis 或 SDK 客户端，并用 `expectResource()` 读取。
- **写入即时、读取为快照**：`setState` 会**立即**更新底层 `ctx.memory`，但不会回写你已经解构出来的那个局部值；本轮若要观察新值，需重新 `equipMemory(key)` 取一次，或自行用局部变量（见上方示例）。
- 返回值的快照（深拷贝），防止直接修改存储的值
- 所有值在读写时都会进行验证和克隆，确保不可变性和可序列化性
- 如果值不符合序列化要求，会在设置时抛出错误

**⚠️ 并发与多 tool 写入（避免丢更新）：**

一次模型调用可能并行触发**多个 tool**，它们跑在**同一个** `ctx.memory` 上。如果两个 handler 都「`await` 前读出快照 → `await` 后用该快照整体写回」，后写的一方会用陈旧基准覆盖先写的一方，**静默丢一条**（经典 lost update）。

```typescript
// ❌ 危险：跨 await 揣着快照再整体覆盖，并发下会丢更新
const [board, setBoard] = equipMemory<Item[]>('board', []);
const snapshot = board;                  // await 之前的快照
const extra = await fetchSomething();
setBoard([...snapshot, extra]);          // 用过期快照覆盖

// ✅ 安全：函数式更新在写入那一刻才取最新值，单线程下是原子的读-改-写
setBoard(prev => [...prev, extra]);
```

- **累加 / 派生写一律用函数式更新** `set(prev => ...)`——它在提交时同步读最新值，并发的多次调用互不覆盖。
- **并行 tool handler 各写各的 key** 也安全（不同 key 不互相覆盖）；会丢更新的只有「多个 handler 对**同一 key** 做快照覆盖写」。
- **跨多个 tool 聚合结果**，更稳妥的落点是在 [`equipToolCallLoopMiddleware`](/zh/api/core#equiptoolcallloopmiddlewaremiddleware) 里聚合（顺序执行，能一次看到整批 tool 输出），或在 `promptAgent` 返回后聚合——这两处都没有并发窗口。

### `equipMemo(key, factory, deps)`

**记忆化 Hook**（语法糖，底层复用 `equipMemory`）。基于依赖数组缓存异步工厂函数的计算结果。当依赖数组未变化时，直接返回缓存值；否则执行工厂函数并更新缓存。适用于昂贵的异步计算、API 调用等需要缓存结果的场景。

**⚠️ 重要限制**：`factory` 返回的值必须是 JSON 可序列化的。

**基本用法：**

```typescript
// 基本用法：缓存昂贵的异步计算
const result = await equipMemo(
  'expensive-computation',
  async () => {
    // 执行昂贵的异步操作
    return await computeHeavyData(input);
  },
  [input.id, input.version]  // 依赖数组
);

// 缓存 API 调用结果
const userData = await equipMemo(
  'user-data',
  async () => await fetchUser(userId),
  [userId]  // 当 userId 不变时，直接返回缓存
);

// 在 Agent handler 中使用
handler: async (props) => {
  // 第一次调用：执行工厂函数并缓存结果
  const data = await equipMemo('api-data', async () => {
    return await fetchAPI(props.endpoint);
  }, [props.endpoint]);
  
  // 如果 props.endpoint 不变，后续 reborn 时会直接返回缓存
  return data;
}
```

**工作原理：**

- 缓存键：使用内部前缀 `__reagent_internal_memo__::` + `key`
- 缓存结构：`{ deps: 上一次的依赖数组, value: 上一次的计算结果 }`
- **依赖比较：深比较（deepEqual）**。相同结构的对象（如 config、params）视为未变化，可直接传内联对象，减少样板代码、无需额外稳定引用。
  - **为什么是深比较（而非像 `equipResource` 那样浅比较）**：memo 的缓存（含 `deps`）经 `equipMemory` 存储，存取都会 `safeClone`，引用身份在克隆中被销毁——读回的 `cache.deps[i]` 永远不与新传入的 `deps[i]` 引用相等。因此对象/数组依赖只能**按值深比较**；若改用浅比较（`Object.is`），任何非原始值依赖都会恒判「已变化」、缓存永不命中。这也正是 `deps` 必须可序列化的原因（要能被 clone）。与 `equipResource` 的差异不是命名随意，而是两者存储模型不同的必然结果。
- 缓存命中：依赖未变化时，直接返回 `cache.value`
- 缓存未命中：依赖变化或缓存不存在时，执行 `factory()` 并更新缓存

**序列化限制：**

由于 `equipMemo` 底层使用 `equipMemory` 存储缓存，因此 `factory` 返回的值必须是 JSON 可序列化的。

- ✅ **允许的类型**：`string`、`number`、`boolean`、`null`、普通对象（plain object）、数组
- ❌ **禁止的类型**：`function`、`symbol`、`undefined`、类实例（`Date`、`Map`、`Set` 等）、循环引用

```typescript
// ✅ 正确用法
const data = await equipMemo('api-data', async () => {
  return { name: 'Alice', age: 30 };  // 普通对象
}, [userId]);

// ❌ 错误用法（会抛出错误）
const date = await equipMemo('date', async () => {
  return new Date();  // Date 实例不可序列化
}, []);

const fn = await equipMemo('fn', async () => {
  return () => {};  // function 不可序列化
}, []);
```

**注意事项：**

- `factory` 必须是异步函数（返回 `Promise<T>`）
- `factory` 返回的值必须是 JSON 可序列化的（字符串、数字、布尔值、null、普通对象、数组）
- 依赖数组中的值也应该是 JSON 可序列化的
- 缓存会在 reborn 后保留，但依赖变化时会重新计算
- **依赖比较**：Memo 使用**深比较**，便于 config、params 等内联对象，减少样板代码

## 资源管理

### `equipResource(key, config)`

**资源管理 Hook**（语法糖）。底层**不是** `equipMemory`：上一次的 `deps` 在运行期单独保存（不进入 `memory` 快照、不做 JSON 序列化）；资源实例与元数据在 **`ctx.resources`**（`active` / `metadata` 两个 Map）。基于依赖数组管理资源的生命周期（创建和销毁）。当依赖数组变化时，自动销毁旧资源并创建新资源；依赖未变化时，返回缓存的资源实例。适用于数据库连接、文件句柄、网络连接等需要生命周期管理的资源。

支持通过 `expose: true` 将资源暴露给子 Agent，子 Agent 可通过 `expectResource` 获取。

**基本用法：**

```typescript
// 数据库连接资源（私有，仅当前 Agent 可见）
const db = await equipResource('db_conn', {
  create: async () => await connectDB(),
  destroy: async (conn) => await conn.close(),
  deps: [dbConfig.host, dbConfig.port]  // 当配置变化时，自动重建连接
});

// 文件句柄资源
const file = await equipResource('file_handle', {
  create: async () => await openFile(path),
  destroy: async (handle) => await handle.close(),
  deps: [path]  // 当路径变化时，自动关闭旧文件并打开新文件
});

// 暴露资源给子 Agent
const db = await equipResource('database', {
  create: async () => await connectDB(),
  destroy: async (conn) => await conn.close(),
  deps: [],
  expose: true  // 关键：允许子 Agent 通过 expectResource('database') 获取
});

// 在 Agent handler 中使用
handler: async (props) => {
  // 第一次调用：创建资源并缓存
  const db = await equipResource('db', {
    create: async () => await connectDB(props.dbConfig),
    destroy: async (conn) => await conn.close(),
    deps: [props.dbConfig.host, props.dbConfig.port]
  });
  
  // 如果 dbConfig 不变，后续 reborn 时会直接返回缓存的连接
  // 如果 dbConfig 变化，会自动关闭旧连接并创建新连接
  return await db.query('SELECT * FROM users');
}
```

**ResourceConfig 接口：**

```typescript
interface ResourceConfig<T> {
  /** 异步函数，用于创建资源 */
  create: () => Promise<T>;
  /**
   * 异步函数，用于销毁/清理资源（可选）。
   *
   * 省略表示该资源无需 teardown——纯派生值，或当前 Agent 并不「拥有」的借用句柄
   * （例如经 runWith({ providers }) 注入的应用级连接池）。省略时不注册全局
   * teardown，也不会发出 destroy 的 resource:op span。
   *
   * destroy 的有无即「拥有 vs 借用」的信号：给了 = 我拥有、由我关闭；
   * 不给 = 我只借用/派生。
   */
  destroy?: (resource: T) => Promise<void>;
  /** 依赖数组（用于缓存失效；允许不可序列化，见下文） */
  deps: unknown[];
  /** 是否将此资源暴露给子 Agent（默认: false，仅当前 Agent 可见） */
  expose?: boolean;
}
```

**工作原理：**

- **deps 存储**：框架在运行期保存上一次的 `deps`（内部使用带前缀的键，**允许不可序列化**，与 `equipMemory` / `equipMemo` 不同）
- **资源与元数据**：资源实例在 `ctx.resources.active` 的 `key` 下；元数据在 `ctx.resources.metadata` 的同 `key` 下，值为 `{ expose, unregister?, destroyOnce? }`——`expose` 是声明期可见性；`unregister` 用于从全局 Teardown 注销；`destroyOnce` 是逐实例的至多一次销毁闸门（teardown 与 deps 变化两条清理路径共用，即使两边竞争，用户的 `destroy` 也只会执行一次）。未提供 `destroy` 时后两者为 `undefined`
- **依赖比较：浅比较（React 风格）**。按 `Object.is` 逐项比较；引用变化即视为 deps 变化。适用于不可序列化、有副作用的实体（Socket、句柄、回调等）；保持稳定引用可避免不必要的 destroy+create。
  - **为什么是浅比较（而非像 `equipMemo` 那样深比较）**：resource 的 `deps` 按引用存放在 `ctx.ephemeral`（**不 clone**），引用身份得以跨 reborn 保留，故浅比较有意义；同时 `deps` 允许放不可序列化值（Socket、句柄、闭包、类实例），对它们**无法定义深比较**。因此「浅」是被存储模型与可序列化约束共同逼出来的，而非与 `equipMemo` 的不一致——两者各自是其存储方式下唯一成立的比较语义。
- 依赖变化时：
  1. **清理旧资源**（若存在）：
     - **先**从全局 Teardown 队列中注销旧资源的 teardown 函数，收窄与 teardown 并发销毁的竞争窗口
     - 再经 `destroyOnce` 闸门调用 `destroy(旧资源)`（即使与 teardown 竞争，也至多执行一次）；旧资源未提供 `destroy` 时跳过销毁，直接移除
  2. **创建新资源**：调用 `create()` 创建新资源
  3. **注册到全局 Teardown**（仅当提供了 `destroy`）：将新资源的销毁函数注册到 Agent 的 teardown 队列
     - 这样直接关闭 Agent 时资源也能自动释放
  4. **更新缓存**：保存新资源、依赖数组和元数据（`expose` / `unregister` / `destroyOnce`）
- 依赖未变化时：直接返回缓存的资源实例

**自动清理机制：**

- 资源创建后会自动注册到 Agent 的全局 Teardown 队列
- Agent 执行完成时（无论成功或失败），会在 `finally` 块中按 LIFO 顺序执行所有 teardown 函数
- 这确保了即使没有触发 reborn，资源也能在 Agent 结束时正确释放
- 依赖变化时，旧资源的 teardown 会自动注销，避免重复销毁
- 未提供 `destroy` 的资源（借用/派生）不注册 teardown，Agent 结束时不做任何清理

**注意事项：**

- `create` 必须是异步函数；`destroy` **可选**，提供时也必须是异步函数
- `destroy` 函数接收资源实例作为参数，负责清理资源（如关闭连接、释放句柄等）；省略 `destroy` 表示资源是借用/派生的、无需清理（见上方 `ResourceConfig` 说明）
- 如果 `destroy` 执行失败，会记录警告但不会阻止新资源的创建或 Agent 的执行
- **`deps` 允许不可序列化**（函数、类实例、闭包、`Symbol` 等），在运行期按引用保存；**浅比较**，引用变化即视为依赖变化
- 资源会在 reborn 后保留，但依赖变化时会自动重建
- 适用于需要显式清理的资源（如数据库连接、文件句柄、网络连接），不适合纯数据缓存（应使用 `equipMemo`）
- 资源清理顺序遵循 LIFO（后进先出）原则，确保依赖关系正确的资源按正确顺序清理
- **`expose: true`** 时，资源会被存储到 `ctx.providers` Map 中，子 Agent 可通过 `expectResource` 获取
- 即使命中缓存，如果 `expose: true`，也会确保资源在 `providers` Map 中（处理 reborn 场景）
- **依赖比较**：Resource 使用**浅比较（React 风格，Object.is 逐项）**；`deps` 可含不可序列化值，但需保持引用稳定（如提取到外部变量或 `useCallback`），避免内联对象/匿名函数导致重复重建
- ⚠️ **调用顺序**：使用 `expose: true` 时，必须在调用子 Agent **之前**调用 `equipResource`，否则子 Agent 执行时 `providers` 中尚未注册该资源，`expectResource` 会抛出找不到资源的错误
- 在 `equipResource` 中托管 MCP Client、再与 `equipMCP` 配合；子 Agent 用 `expectResource` 取暴露的 Client，约定与示例见 [Adapter · MCP](/zh/api/adapter/mcp)

## 持久化状态

与**仅存活于单次 Agent invocation 的内存** `equipMemory` / `equipMemo`（跨 `reborn`，但 Agent 返回即销毁）不同，跨 Agent / 跨 Session 的持久化应通过 `runWith({ providers })` 注入真实数据库、Redis 或 SDK 客户端，再用 `expectResource()` 读取。完整说明与示例见 [Expect · 持久化状态](/zh/api/expect#持久化状态)。

## 预算控制

> 📖 **详细文档**：参见 [Budget 机制](/zh/api/budget) 了解层级化追踪、使用统计与 `onUpdate` 回调。

### `equipBudget(config)`

注册预算配置（必填）。将配置加入当前上下文的 `budgetConfigs`。可通过 `config.onUpdate` 在每次用量更新时（沿上下文链依次）收到回调。查询当前用量请使用 `getUsageStats()`。

```typescript
equipBudget({
  onUpdate: ({ delta, aggregate }) => {
    console.log('Updated', aggregate.costs, aggregate.totalTokens);
  }
});
```

**BudgetUpdateArg / BudgetConfig：**

```typescript
interface BudgetUpdateArg {
  delta: UsageStats;    // 本次用量增量
  aggregate: UsageStats; // 当前上下文聚合用量（自身+子 Agent）
  own: UsageStats;      // 当前上下文自身用量
}

interface BudgetConfig {
  /** 用量更新时回调，沿上下文链依次调用（必填） */
  onUpdate: (arg: BudgetUpdateArg) => void;
}

interface BudgetState {
  own: UsageStats;       // 当前 Agent 自身消费
  aggregate: UsageStats;  // 当前 Agent + 所有子 Agent 的聚合消费
}

interface UsageStats {
  costs: Record<string, number>;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  callCount: number;
  items: UsageItem[];
}
```

## 作用域传递

### `equipScope(data)`

为子 Agent 提供环境变量（作用域数据）。数据以层级方式叠加到作用域栈中，子 Agent 可通过 `expectScope` 读取。**键级覆盖**：子层的 key 会遮蔽父层（不进行深度合并）。**生命周期**：Draft 状态，reborn 后需重新调用。

**值限制**：除 `undefined` 外，仅允许 JSON 可序列化的值。`undefined` 允许出现，合并时**会用子层的 `undefined` 覆盖父层同 key 的值**，用于“清除”上游传入的字段。

```typescript
// 父 Agent 提供作用域
handler: async () => {
  equipScope({
    userId: 'u_123',
    config: { debug: true }
  });

  // 子 Agent 可以读取这些数据
  await ChildAgent({ ... });
}

// 子层用 undefined 覆盖父层同 key，可用来清除上游值
equipScope({ theme: 'dark' });        // 父
// 子：equipScope({ theme: undefined }) → 合并后 theme 为 undefined
```

**基本示例（来自 expect-scope 测试）：**

```typescript
// 父提供，子读取
const ParentAgent = createAgent({
  id: 'parent',
  model: adapter,
  handler: async () => {
    equipScope({ userId: 'u_123', debug: true });
    return await ChildAgent({});
  },
});

const ChildAgent = createAgent({
  id: 'child',
  model: adapter,
  handler: async () => {
    const ctx = expectScope(z.object({
      userId: z.string(),
      debug: z.boolean(),
    }));
    // ctx.userId === 'u_123', ctx.debug === true
    return { done: true };
  },
});
```

**undefined 覆盖之前 value 的示例：**

```typescript
// 父设置 theme，子用 undefined 清除，孙用 optional 读取
const GrandchildAgent = createAgent({
  id: 'grandchild',
  model: adapter,
  handler: async () => {
    const ctx = expectScope(z.object({
      theme: z.string().optional(),
    }));
    expect(ctx.theme).toBeUndefined(); // 被子层 undefined 覆盖
    return { done: true };
  },
});

const ChildAgent = createAgent({
  id: 'child',
  model: adapter,
  handler: async () => {
    equipScope({ theme: undefined }); // 显式清除父层的 theme
    return await GrandchildAgent({});
  },
});

const ParentAgent = createAgent({
  id: 'parent',
  model: adapter,
  handler: async () => {
    equipScope({ theme: 'dark' });
    return await ChildAgent({});
  },
});
```

**以下会抛出 TypeError：**

```typescript
equipScope({ handler: () => {} });        // function 禁止
equipScope({ id: Symbol('id') });         // symbol 禁止
equipScope({ date: new Date() });         // class instance 禁止
equipScope({ items: new Map() });         // class instance 禁止
```

## 追踪属性

### `equipTraceAttr(attrs: Record<string, unknown>, options?: EquipTraceAttrOptions)`

为当前 Agent 运行挂上追踪属性（span attributes）。默认（`target: 'agent'`）这些属性会合并到 **`agent:end`** 以及每一轮 **`generation:end`** 事件的 `trace.attributes` 中，便于在分布式追踪或日志里按请求 ID、用户 ID 等维度过滤与聚合。

**EquipTraceAttrOptions：**

```typescript
interface EquipTraceAttrOptions {
  /**
   * 属性挂载位置：
   * - 'agent'（默认）：合并进 draft，随本 agent 的 agent:end 与各轮 generation:end 事件发出
   * - 'local'：立即合并进当前 trace span
   * - 'root'：沿上下文链上溯到顶层（runWith）context，立即合并进其 span；
   *   体现在 runWith:end 上（runWith:start 已发出）。用于在深层嵌套的
   *   子 Agent 里给整个 run 的根 span 打标。
   */
  target?: 'agent' | 'local' | 'root';
}
```

**行为：**

- 多次调用会合并到同一对象：**同 key 后覆盖前**，不同 key 累加。
- 仅支持 **JSON 可序列化** 的值（与 `equipScope` 相同限制），否则会抛出 `TypeError`。
- **生命周期**：`target: 'agent'`（默认）是 Draft 状态，每次 reborn 会清空，若需要在下一轮继续打标需再次调用；`'local'` / `'root'` 则**立即写入**对应 span，不随 reborn 清空。
- 在 runWith 根上下文（Agent handler 之外）以默认 `target: 'agent'` 调用会告警——那里没有 `agent:end` 事件可挂，请改用 `{ target: 'local' }` 或 `{ target: 'root' }`。
- **key 命名**：key 会原样成为 OTLP span attribute（不加前缀）。`rejelly.` 前缀为框架保留，以其开头的 key 会被跳过并告警；也应避免复用 OTel 语义约定 key（`http.*`、`service.*`、`user.id` 等），以免混淆 OTel 感知的后端。

**与 runWith 的 trace 区别：**

- `runWith` 的 `trace` 选项用于**透传外部链路**（traceId、parentSpanId、根 span 名称、初始 attributes），在创建根 context 时生效。
- `equipTraceAttr` 在 **handler 内** 按需打标，最终体现在该 agent 的 agent:end 与各 generation:end 的 span 上。

```typescript
handler: async (props) => {
  equipTraceAttr({ userId: props.userId, requestId: props.requestId });
  // ... 后续 agent:end / generation:end 的 trace.attributes 会包含上述字段
  return await promptAgent(schema);
}

// 多次调用：后覆盖前、新 key 合并
equipTraceAttr({ a: 1 });
equipTraceAttr({ b: 2 });
equipTraceAttr({ a: 3 });  // 最终 attributes: { a: 3, b: 2 }

// 在深层子 Agent 里给整个 run 的根 span 打标（立即写入，体现在 runWith:end）
equipTraceAttr({ runLabel: 'nightly-batch' }, { target: 'root' });
```
