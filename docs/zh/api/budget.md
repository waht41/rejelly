# Budget 机制

Budget 机制提供层级化的资源消耗监控，在 Agent 调用链中追踪成本（Cost）和 Token 使用情况，并支持通过 `onUpdate` 在每次用量更新时收到回调。

## 核心概念

### BudgetState

每个 Agent 的上下文（Context）中都维护着一个 `BudgetState`，包含两个维度的使用统计：

- **`own`**: 当前 Agent 自身的直接消费（Self Time）
  - 记录当前 Agent 直接调用的 Model 和 Tool 产生的消费
  - 用于分析 Agent 自身的行为模式

- **`aggregate`**: 聚合消费（Total Time）
  - 包含当前 Agent 自身以及所有子 Agent 的消费总和
  - 相同类型和名称的消费项会被合并（按 `type + name` 聚合）

```typescript
interface BudgetState {
  own: UsageStats       // 当前 Agent 自身消费
  aggregate: UsageStats  // 当前 Agent + 所有子 Agent 的聚合消费
}
```

### getUsageStats()

获取当前 Agent 的使用统计信息，返回包含 `own` 和 `aggregate` 的 `BudgetState`（安全克隆，可放心修改）。

```typescript
const budgetState = getUsageStats()

// 当前 Agent 自身的消费（costs: 按计费单位的整数，如 micro_usd）
console.log('Own costs:', budgetState.own.costs, budgetState.own.totalTokens)

// 包含子 Agent 的聚合消费
console.log('Aggregate costs:', budgetState.aggregate.costs, budgetState.aggregate.totalTokens)
```

## 层级化 Budget 追踪

### 更新链

当发生用量更新（LLM 调用或 `recordToolUsage`）时：

1. **更新链**：从当前 Context 沿父级链向上，更新每个节点的 `own`（仅发起节点）和 `aggregate`
2. **onUpdate 回调**：对链上每一层，对该层 `budgetConfigs` 中每个配置的 `onUpdate` 依次调用，传入 `{ delta, aggregate }`（先当前上下文，再父级）

```typescript
// 父 Agent
const ParentAgent = createAgent({
  id: 'ParentAgent',
  handler: async () => {
    equipBudget({
      onUpdate: ({ delta, aggregate }) => {
        console.log('Parent aggregate', aggregate.costs)
      }
    })
    await ChildAgent({ ... })
  }
})

// 子 Agent
const ChildAgent = createAgent({
  id: 'ChildAgent',
  handler: async () => {
    equipBudget({
      onUpdate: ({ delta, aggregate }) => {
        console.log('Child aggregate', aggregate.costs)
      }
    })
    await promptAgent(...)
    // 每次用量更新会先触发子 Agent 的 onUpdate，再触发父 Agent 的 onUpdate
  }
})
```

## 使用示例

### 基础用法

```typescript
import { createAgent, equipBudget, getUsageStats, promptAgent } from '@rejelly/core'

const MyAgent = createAgent({
  id: 'MyAgent',
  handler: async () => {
    await promptAgent(...)

    const state = getUsageStats()
    console.log('Own usage:', state.own)
    console.log('Aggregate usage:', state.aggregate)
  }
})
```

### 使用 onUpdate

```typescript
equipBudget({
  onUpdate: ({ delta, aggregate }) => {
    console.log('Delta:', delta.costs, delta.totalTokens)
    console.log('Aggregate:', aggregate.costs, aggregate.totalTokens)
  }
})
```

### 层级中查看总消费

```typescript
const ParentAgent = createAgent({
  id: 'ParentAgent',
  handler: async () => {
    equipBudget({ onUpdate: ({ aggregate }) => report(aggregate) })
    await ChildAgent1({ ... })
    await ChildAgent2({ ... })

    const state = getUsageStats()
    console.log('Total costs:', state.aggregate.costs)
  }
})
```

## API 参考

### equipBudget(config)

注册预算配置（必填）。查询当前用量请使用 `getUsageStats()`。

**参数：**
- `config`: 必填，包含 `onUpdate` 等回调的配置

**返回：** `void`

```typescript
interface BudgetUpdateArg {
  delta: UsageStats   // 本次用量增量
  aggregate: UsageStats  // 当前上下文聚合用量（自身+子 Agent）
  own: UsageStats     // 当前上下文自身用量
}

interface BudgetConfig {
  onUpdate: (arg: BudgetUpdateArg) => void  // 必填
}
```

### getUsageStats()

获取当前 Agent 的使用统计信息（安全克隆）。

**返回：** `BudgetState`

```typescript
interface BudgetState {
  own: UsageStats        // 当前 Agent 自身的消费
  aggregate: UsageStats  // 包含所有子 Agent 的聚合消费
}

interface UsageStats {
  /** 按计费单位聚合的整数消耗（如 micro_usd）；与物理量 unit（如 image）分离 */
  costs: Record<string, number>
  totalTokens: number
  promptTokens: number
  completionTokens: number
  callCount: number
  items: UsageItem[]     // 详细的消费项列表
}
```

### recordToolUsage(toolUsage)

在无 LLM 调用的场景下记录工具消费（如外部 API、画图等），会参与层级更新并触发链上各层的 `onUpdate`。

```typescript
recordToolUsage({ name: 'dall-e', costs: { micro_usd: 40_000 }, quantity: 1, unit: 'image' })
```

## 注意事项

1. **BudgetState 始终更新**：即使没有调用 `equipBudget(config)`，`BudgetState` 也会在每次 LLM/工具消费时更新。

2. **onUpdate 调用顺序**：从当前上下文开始，沿父级链依次调用每层 config 的 `onUpdate`；同一层多个 config 按数组顺序调用。

3. **共享状态**：若多个 Context 共享同一 `budgetState` 实例，遍历链时会跳过重复的父级，避免重复更新与重复回调。
