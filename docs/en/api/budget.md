# Budget

The Budget mechanism provides hierarchical resource consumption monitoring, tracking costs and token usage along the Agent call chain, and supports callbacks via `onUpdate` whenever usage is updated.

## Core Concepts

### BudgetState

Every Agent's Context maintains a `BudgetState` with two dimensions of usage statistics:

- **`own`**: The current Agent's direct consumption (Self Time)
  - Records consumption from Model and Tool calls made directly by the current Agent
  - Used for analyzing the Agent's own behavior patterns

- **`aggregate`**: Aggregated consumption (Total Time)
  - Includes the sum of the current Agent's own consumption plus all sub-agents' consumption
  - Consumption items with the same type and name are merged (aggregated by `type + name`)

```typescript
interface BudgetState {
  own: UsageStats       // Current Agent's own consumption
  aggregate: UsageStats  // Current Agent + all sub-agents aggregated consumption
}
```

### getUsageStats()

Retrieves the current Agent's usage statistics, returning a `BudgetState` with `own` and `aggregate` (safe clone — feel free to modify).

```typescript
const budgetState = getUsageStats()

// Current Agent's own consumption (costs: integer values per billing unit, e.g. micro_usd)
console.log('Own costs:', budgetState.own.costs, budgetState.own.totalTokens)

// Aggregated consumption including sub-agents
console.log('Aggregate costs:', budgetState.aggregate.costs, budgetState.aggregate.totalTokens)
```

## Hierarchical Budget Tracking

### Update Chain

When a usage update occurs (LLM call or `recordToolUsage`):

1. **Update chain**: Traverses up the parent chain from the current Context, updating each node's `own` (initiating node only) and `aggregate`
2. **onUpdate callback**: For each level in the chain, calls the `onUpdate` of each config in that level's `budgetConfigs` with `{ delta, aggregate }` (current context first, then parent)

```typescript
// Parent Agent
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

// Child Agent
const ChildAgent = createAgent({
  id: 'ChildAgent',
  handler: async () => {
    equipBudget({
      onUpdate: ({ delta, aggregate }) => {
        console.log('Child aggregate', aggregate.costs)
      }
    })
    await promptAgent(...)
    // Each usage update triggers the child Agent's onUpdate first, then the parent Agent's onUpdate
  }
})
```

## Usage Examples

### Basic Usage

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

### Using onUpdate

```typescript
equipBudget({
  onUpdate: ({ delta, aggregate }) => {
    console.log('Delta:', delta.costs, delta.totalTokens)
    console.log('Aggregate:', aggregate.costs, aggregate.totalTokens)
  }
})
```

### Viewing Total Consumption in Hierarchy

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

## API Reference

### equipBudget(config)

Registers a budget configuration (required). To query current usage, use `getUsageStats()`.

**Parameters:**
- `config`: Required, contains `onUpdate` and other callbacks

**Returns:** `void`

```typescript
interface BudgetUpdateArg {
  delta: UsageStats   // Usage delta for this update
  aggregate: UsageStats  // Current context aggregate usage (self + sub-agents)
  own: UsageStats     // Current context own usage
}

interface BudgetConfig {
  onUpdate: (arg: BudgetUpdateArg) => void  // Required
}
```

### getUsageStats()

Retrieves the current Agent's usage statistics (safe clone).

**Returns:** `BudgetState`

```typescript
interface BudgetState {
  own: UsageStats        // Current Agent's own consumption
  aggregate: UsageStats  // Aggregated consumption including all sub-agents
}

interface UsageStats {
  /** Integer consumption aggregated by billing unit (e.g. micro_usd); separate from physical unit (e.g. image) */
  costs: Record<string, number>
  totalTokens: number
  promptTokens: number
  completionTokens: number
  callCount: number
  items: UsageItem[]     // Detailed consumption item list
}
```

### recordToolUsage(toolUsage)

Records tool consumption such as external API calls and image generation. Participates in hierarchical updates and triggers `onUpdate` on all levels of the chain. A tool that invokes one or more models can attach `modelUsages`; those tokens contribute to aggregate token statistics and token budgets while remaining attributed to the tool operation.

```typescript
recordToolUsage({ name: 'dall-e', costs: { micro_usd: 40_000 }, quantity: 1, unit: 'image' })
```

```typescript
recordToolUsage({
  name: 'web_search',
  costs: { micro_usd: 12_044 }, // authoritative total cost for the whole tool operation
  quantity: 1,
  unit: 'request',
  modelUsages: [{
    provider: 'openrouter',
    model: 'openai/search-model',
    usage: {
      promptTokens: 8_417,
      completionTokens: 122,
      totalTokens: 8_539,
      details: { cacheReadTokens: 5_248 },
    },
  }],
})
```

`modelUsages` is an attribution breakdown, not another cost ledger. Record the complete provider-reported charge once in the tool's top-level `costs` to avoid double counting.

## Notes

1. **BudgetState always updates**: Even without calling `equipBudget(config)`, `BudgetState` is updated on every LLM/tool consumption.

2. **onUpdate call order**: Starts from the current context, traversing each level's config `onUpdate` up the parent chain; multiple configs at the same level are called in array order.

3. **Shared state**: If multiple Contexts share the same `budgetState` instance, duplicate parents are skipped during chain traversal to avoid duplicate updates and callbacks.
