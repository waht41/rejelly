# 时间旅行 (Time Travel)

通过快照（Snapshot）实现执行状态的持久化、恢复与重放，支持断点续传、从事件追踪恢复、以及基于 `contentHash` 的 Prompt/Tool 缓存重放。相关 API 从 `@rejelly/core/debugger` 引入，`runWith` 从 `@rejelly/core` 引入。

> **警告：生产环境使用 Snapshot 默认会抛错。**

**enableSnapshot：** 根 context 的 `enableSnapshot` 由 `runWith` 的 `options.enableSnapshot` 决定，默认值为 `IS_DEV`（即 `NODE_ENV === 'development'` 或 `'test'` 时为 `true`，可通过 runWith 参数修改默认值）。当 `enableSnapshot` 为 `false` 时：journal 记录与子 Agent 帧保存都会跳过；调用 `dumpSnapshot()` 会抛出 `SnapshotDisabledError`。若需要**生产环境**的快照，可在运行期间采集事件追踪（TraceEvent），事后用 `restoreSnapshot(trace.events)` 从事件线重建快照，然后在本地回放、调试。

---

## `dumpSnapshot(options?)`

导出当前 Agent 执行状态的快照，用于持久化和后续重放。函数会自动从当前上下文获取状态，无需传入上下文参数；可选的 `options.metadata` 用于附加用户自定义标签。

```typescript
import { dumpSnapshot } from '@rejelly/core/debugger';

// 在 Agent 执行过程中导出快照（自动获取当前上下文）
const snapshot = dumpSnapshot();

// 可选：附加自定义标签
const taggedSnapshot = dumpSnapshot({ metadata: { reason: 'before migration' } });

// 保存快照到文件或数据库
await saveSnapshot(snapshot);
```

**返回值（核心结构；字段与 `@rejelly/core/debugger` 导出的类型保持一致）：**

```typescript
interface AgentSnapshot {
  /** 进程标识符 */
  processId: string;
  /** 快照创建时间戳 */
  timestamp: number;
  /** 根帧快照（包含所有子 Agent 的执行记录） */
  root: AgentFrameSnapshot;
  /** 追踪来源与恢复锚点 */
  provenance: { traceId: string; spanId?: string; anchor?: 'before' | 'after'; source?: 'dump' | 'restore' };
  /** 快照格式版本 */
  version: number;
  /** 用户自定义标签 */
  metadata?: Record<string, unknown>;
}

interface AgentFrameSnapshot {
  /** 调用 ID */
  callId: string;
  /** Agent ID */
  agentId: string;
  /** 内存状态（JSON 可序列化） */
  memory: Record<string, unknown>;
  /** 执行日志（用于重放拦截）。prompt/tool 的 key 为 contentHash（输入哈希），与 callId 解耦 */
  journal: {
    /** LLM 调用记录，key = contentHash */
    prompt: Record<string, JournalEntry>;
    /** 工具调用记录，key = contentHash */
    tool: Record<string, JournalEntry>;
  };
  /** 子 Agent 执行历史树，key = callId */
  children: Record<string, AgentFrameSnapshot>;
  /** 执行状态 */
  state: {
    /** 状态：'running' | 'completed' | 'failed' */
    status: 'running' | 'completed' | 'failed';
    /** 如果 status === 'completed'，存储返回值 */
    output?: unknown;
    /** 如果 status === 'failed'，存储错误信息 */
    error?: unknown;
  };
  /** 当前帧自身及聚合用量 */
  budgetState: BudgetState;
}
```

**Call ID 与 Journal 的职责分离：**

- **callId**：格式为 `${parentCallId}/${type}:${configId}:${seq}`。`seq` 由上下文的 `callCounters` 在每次调用时严格递增生成（agent / prompt / tool 均如此），保证同一次运行内多次调用（如连续 3 次 search）得到不同 callId（如 `root/tool:search:0`、`:1`、`:2`）。用于：
  - 拓扑结构：`children` 的 key、父子帧关系
  - 分布式追踪（OpenTelemetry）与 DevTool 时间轴树状图，避免 Span ID 冲突
- **Journal**：仅负责“输入 → 输出”的缓存。prompt / tool 的 journal 以 **contentHash**（输入哈希）为 key 读写，与 callId 无关；重放时用当前请求的 contentHash 查表，命中则直接返回缓存结果。因此缓存逻辑与“第几次调用”解耦。

**工作原理：**

1. **遍历上下文链**：从当前上下文向上遍历到根上下文，构建完整的上下文链
2. **构建嵌套帧**：为上下文链中的每个 Agent 创建帧快照，包括：
   - 内存状态（从 `ctx.memory` Map 转换为普通对象）
   - 执行日志（从 `ctx.draft.journal` 复制；prompt/tool 以 contentHash 为 key）
   - 子 Agent 帧（从 `ctx.draft.children` 复制，key 为 callId）
   - 执行状态（根据当前是否正在运行设置）
3. **处理运行中状态**：如果某个 Agent 仍在运行，会标记为 `status: 'running'`

**使用场景：**

- **持久化执行状态**：保存 Agent 执行到某个点的完整状态，用于后续恢复
- **调试和审计**：记录完整的执行轨迹，包括所有子 Agent 的调用历史
- **断点续传**：在长时间运行的 Agent 中，定期保存快照，支持中断后恢复

**注意事项：**

- 仅当当前 context 的 `enableSnapshot` 为 `true` 时可调用；否则会抛出 `SnapshotDisabledError`（可从 `@rejelly/core` 引入 `isSnapshotDisabledError` 判断）。
- 快照只包含 JSON 可序列化的数据（内存、日志等）
- 非序列化的数据（如函数、类实例）会被忽略或标记为错误
- 快照是深拷贝，修改快照不会影响原始上下文
- promptAgent 的输入哈希包括 prompt，schema，model id，model provider
- tool 的原理是在洋葱模型的最内部添加了 cache 中间件

---

## `runWith(fn, options?)` 与快照

在可选的快照恢复上下文中执行函数。如果提供了 `options.snapshot`，会从快照恢复根上下文再执行；否则正常执行。

```typescript
import { runWith } from '@rejelly/core';
import { dumpSnapshot } from '@rejelly/core/debugger';

// 正常执行（无快照）
const result = await runWith(async () => {
  const agent = createAgent({ ... });
  const result = await agent({ input: 'test' });
  const snapshot = dumpSnapshot(); //注意，此api仅限于调试环境使用
  return result;
});

// 使用快照恢复执行
const snapshot = await loadSnapshot(); // 从文件或数据库加载
const result = await runWith(async () => {
  const agent = createAgent({ ... });
  return await agent({ input: 'test' }); //使用快照后，Agent会快速重放，根据journal跳过tool，llm的执行，直接
}, { snapshot });
```

**与快照相关的选项：**

```typescript
interface RunWithOptions<P = unknown> {
  /** 注入快照用于上下文恢复；若提供则从快照恢复根上下文后再执行 */
  snapshot?: AgentSnapshot;
  /**
   * 是否开启快照（默认 IS_DEV）。
   * 为 true 时：会记录 journal、保存子帧，可调用 dumpSnapshot。
   * 为 false 时：recordJournal / saveChildFrame 直接 return，dumpSnapshot() 会抛 SnapshotDisabledError。
   */
  enableSnapshot?: boolean;
  // ... 其他选项见 core 文档
}
```

**有快照时的工作原理：**

1. 从快照的根帧恢复根上下文
2. 恢复内存状态（从 `frame.memory` 恢复到 `ctx.memory`）
3. 设置快照到上下文（用于重放拦截）
4. 在恢复的上下文中执行函数
5. 子 Agent 会在调用时自动从父上下文的 `snapshot.children` 中恢复自己的帧

**重放机制：**

当 Agent 在恢复的上下文中执行时：

- **Prompt 重放**：如果快照中包含相同的 prompt 调用记录（基于 `contentHash` 匹配），会直接返回缓存的结果，不调用 LLM
- **Tool 重放**：如果快照中包含相同的工具调用记录（基于 `contentHash` 匹配），会直接返回缓存的结果，不执行工具
- **子 Agent 重放**：子 Agent 会从父上下文的 `snapshot.children` 中恢复自己的帧，并递归应用重放机制

**使用场景：**

- **测试和调试**：使用保存的快照重现特定的执行场景
- **成本优化**：在开发环境中使用快照，避免重复调用 LLM 和工具
- **断点续传**：从保存的快照恢复执行，继续未完成的任务
- **审计和合规**：重现历史执行过程，验证结果一致性

**snapshot 恢复注意事项：**

- 如果使用了 `snapshot`，快照只会在 `runWith` 开始时恢复一次。
- 快照恢复的上下文状态（内存、重放缓存等）会在整个 `runWith` 调用期间保持不变。
- 快照中的 prompt 和 tool 调用会基于哈希值匹配，输入完全一致才会命中缓存；若输入变化则正常执行并更新快照。
- runWith 只注入 snapshot，子 Agent 会在调用时自动恢复。
- 子 Agent 的恢复依赖 `snapshot.children[callId]`。`callId` 中的 `seq` 按实际调用 `SubAgent(...)` 的顺序分配，因此并行调用同一个子 Agent 时，应让子 Agent 调用发生在同步构造阶段，保证原运行和重放时顺序一致：

```typescript
// 推荐：SubAgent(...) 在 map 的同步阶段启动，seq 按 items 顺序稳定分配
const tasks = items.map(item => SubAgent({ text: item.text }));
await Promise.all(tasks);
```

- 避免在调用子 Agent 之前插入 `await`、`setTimeout` 或其他调度不确定的逻辑。否则相同 `configId` 的并行子 Agent 可能因启动时机不同拿到不同 `seq`，导致 `snapshot.children[callId]` 错位或 miss：

```typescript
// 不推荐：SubAgent(...) 发生在 await 之后，seq 取决于异步完成顺序
const tasks = items.map(async item => {
  const prepared = await prepare(item);
  return SubAgent({ text: prepared.text });
});
await Promise.all(tasks);
```

- 如果每个 item 都需要异步准备，先并行准备数据，再按稳定数组顺序同步启动子 Agent：

```typescript
const prepared = await Promise.all(items.map(item => prepare(item)));
const tasks = prepared.map(item => SubAgent({ text: item.text }));
await Promise.all(tasks);
```

- 非序列化的数据在快照中会被标记为错误，重放时会跳过这些缓存。

---

## `restoreSnapshot(trace, options?)`

从线性的事件追踪数组（TraceEvent）中恢复 AgentSnapshot，实现时间旅行功能。通过重建树形结构来恢复完整的 Agent 执行状态。

```typescript
import { EVENTS } from '@rejelly/core';
import type { TraceEvent, AgentEndEvent } from '@rejelly/core';
import { restoreSnapshot } from '@rejelly/core/debugger';

// 从 Review、EventBus 订阅结果或持久化存储取得已采集的事件
declare const events: TraceEvent[];

// 方式1: 最简单的用法 - 恢复到最新状态（推荐）
const snapshot = restoreSnapshot(events);

// 方式2: 恢复到指定 span 的结束事件
const agentEndEvent = events.find(
  e => e.type === EVENTS.AGENT_END
) as AgentEndEvent | undefined;

if (agentEndEvent) {
  const snapshot = restoreSnapshot(events, {
    spanId: agentEndEvent.trace.spanId,
    anchor: 'after'
  });
  const result = await runWith(async () => {
    return await MyAgent({ input: 'test' });
  }, { snapshot });
}
```

**函数签名：**

```typescript
export function restoreSnapshot(
  trace: TraceEvent[],
  options?: RestoreOptions
): AgentSnapshot;

interface RestoreOptions {
  /**
   * 目标 span ID，用于确定恢复到哪个时间点
   * 如果不提供，默认恢复到 Trace 的最后一条事件（最新状态）
   */
  spanId?: string;

  /**
   * 恢复时间锚点
   * - 'before': 恢复到该 span 开始之前（用于重试场景）
   *   快照不包含该 span 的执行记录，恢复后 Agent 会重新执行
   * - 'after': 恢复到该 span 结束之后（用于恢复场景，默认值）
   *   快照包含该 span 的执行结果和缓存，恢复后 Agent 会跳过实际执行直接使用缓存
   * @default 'after'
   */
  anchor?: 'before' | 'after';
}
```

**工作原理：**

函数使用基于栈的状态机从扁平的事件时间线重建嵌套的帧层次结构：

1. **定位截断点**：根据目标 `spanId` 和 `anchor` 模式确定要包含哪些事件
   - 如果 `spanId` 未提供：默认恢复到 Trace 的最后一条事件（最新状态）
   - `anchor: 'after'`：找到该 span 的结束事件，包含该事件及之前的所有事件
   - `anchor: 'before'`：找到该 span 的开始事件，只包含该事件之前的事件（不包含开始事件）

2. **重放状态**：按时间顺序处理事件，重建：
   - **帧结构**：通过 `AGENT_START` / `AGENT_END` 事件重建 Agent 层次结构
   - **内存状态**：从 `GENERATION_END` 事件恢复内存状态
   - **Prompt 缓存**：从 `TURN_END` 事件恢复 LLM 调用缓存（基于 `contentHash`）
   - **Tool 缓存**：从 `TOOLS_EXECUTE_END` 事件恢复工具调用缓存（基于 `contentHash`）

3. **状态修复**：
   - 将截断时仍在运行的帧标记为 `status: 'running'`
   - **Best Effort 自动修正**：如果父 Agent 结束时栈中还有未关闭的子 Agent（僵尸子节点），会自动将它们标记为 `failed` 状态，并记录错误信息。这保证了快照数据结构的逻辑一致性（不会出现已完成父节点包含运行中子节点的矛盾状态）

**Anchor 模式说明：**

- **`'after'`（默认）**：恢复到目标 span 结束之后
  - 快照包含该 span 的执行结果和缓存条目
  - 恢复后，Agent 会跳过实际执行，直接使用缓存结果
  - 适用于"恢复"场景，例如从某个已完成步骤继续执行

- **`'before'`**：恢复到目标 span 开始之前
  - 快照不包含该 span 的任何执行痕迹
  - 恢复后，Agent 从零开始重新执行
  - 适用于"重试"场景，例如某个步骤失败后重新执行

**使用示例：**

```typescript
import { runWith, EVENTS } from '@rejelly/core';
import type { TraceEvent, AgentStartEvent, AgentEndEvent } from '@rejelly/core';
import { restoreSnapshot } from '@rejelly/core/debugger';

// 场景1: 恢复到最新状态
async function restoreToLatest(trace: TraceEvent[]) {
  const snapshot = restoreSnapshot(trace);
  return await runWith(async () => await MyAgent({ input: 'test' }), { snapshot });
}

// 场景2: 恢复执行（跳过已完成的步骤）
async function resumeExecution(trace: TraceEvent[]) {
  const stepEndEvent = trace.find(
    e => e.type === EVENTS.AGENT_END && e.trace.spanId === 'step_123'
  ) as AgentEndEvent;
  const snapshot = restoreSnapshot(trace, {
    spanId: stepEndEvent.trace.spanId,
    anchor: 'after'
  });
  return await runWith(async () => await MyAgent({ input: 'test' }), { snapshot });
}

// 场景3: 重试执行（重新执行失败的步骤）
async function retryExecution(trace: TraceEvent[]) {
  const stepStartEvent = trace.find(
    e => e.type === EVENTS.AGENT_START && e.trace.spanId === 'step_123'
  ) as AgentStartEvent;
  const snapshot = restoreSnapshot(trace, {
    spanId: stepStartEvent.trace.spanId,
    anchor: 'before'
  });
  return await runWith(async () => await MyAgent({ input: 'test' }), { snapshot });
}
```

**与 `dumpSnapshot()` 的区别：**

- **`dumpSnapshot()`**：从当前运行的 Agent 上下文直接导出快照，需要 Agent 正在执行，且当前 context 的 `enableSnapshot` 为 `true`。
- **`restoreSnapshot()`**：从历史事件追踪恢复快照，不需要 Agent 正在执行、也不依赖 `enableSnapshot`，可从任何时间点恢复。**生产环境**即使未开启快照，只要在运行中采集了事件追踪，即可事后用 `restoreSnapshot(trace.events)` 重建 Snapshot，用于回放、审计或问题复现。

**与 `runWith()` 的关系：**

- `restoreSnapshot()` 生成快照，`runWith()` 使用快照恢复执行
- 两者配合使用可以实现完整的时间旅行功能：从事件追踪恢复快照，然后使用快照恢复执行

**错误处理：**

函数会在以下情况抛出错误：

- Trace 为空
- 目标 `spanId` 在事件追踪中不存在（当提供了 `spanId` 时）
- `anchor: 'before'` 且目标 span 位于追踪开始位置（无法再往前恢复）
- 无法创建根 Agent 帧（通常发生在 `anchor: 'before'` 且目标是根 Agent 时）

**注意事项：**

- **默认行为**：如果 `spanId` 未提供，会自动恢复到 Trace 的最后一条事件
- 事件追踪会按时间戳自动排序，确保按时间顺序处理
- 恢复的快照中的 prompt 和 tool 缓存基于 `contentHash` 匹配，确保输入完全一致才会命中
- 非序列化的数据（如函数、类实例）在事件追踪中不会保存，恢复时这些数据会丢失
- 恢复的快照可以像 `dumpSnapshot()` 生成的快照一样使用，传递给 `runWith()` 进行恢复执行
