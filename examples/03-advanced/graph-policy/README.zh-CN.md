# Graph Policy

> 中文 | [English](README.md)

这是一个 LangGraph 风格的图：类型化 state、条件边、循环、并行 fan-out，但实现为一个 **自定义 prompt policy**。Core 本身不感知图；这里的能力都基于 `@rejelly/core/policy` 工具集构建（`createAgentPolicy`、`executeTurn`、`executeValidation`、`normalizeMessages`、`createJsonOutputParser`、`transferJsonSchema`）。

```
draft ──► critique ──► END     (两个 critic 都通过，或 turn budget 偏低)
           │  ▲
           ▼  │
          revise               (循环回去再修一轮)
```

## 文件

- `graph-policy.ts`：迷你图运行时。`createGraphPolicy({ policyId, graph, finalText })` 返回一个 policy 函数，用法和 `promptAgent` 一样（每个 generation 只调用一次，在 equips/expects 之后）。节点会拿到 `GraphHelpers`：`callText` / `callStructured`（每次各消耗一个 `executeTurn`）以及 `remainingTurns()`。
- `writer-critic-agent.ts`：具体图实现。writer 先起草，两个 critic persona **并行**评审（`Promise.all` 包住 `executeTurn`，可 journal、可 replay），条件边决定进入 revise 还是结束。示例 state 保存 draft 和 critique 快照，让 CLI 能在最终答案前展示中间过程。

## 演示内容

1. **图策略本质上只是 policy。** Agent handler 仍然是 `equip → expect → one prompt call`；图（nodes、edges、state、cycles）完全是 policy 的内部视图。config、equip、policy 的分层不需要改。
2. **节点级 prompt 是 policy 参数，不是 equip。** `equipSystem` / `equipInstruction` 形成每个节点都能看到的共享基础；节点专属 prompt 放在 graph spec 里。Equip 描述的是这个 Agent 在一个 generation 里的单一交互面。
3. **validator 契约。** 中间节点输出用节点自己的 parser 解析（刻意不走 `executeValidation`）；`expectValidator()` 只应作用在 **最终** 输出上，policy 返回前会对最终输出执行 `executeValidation`。
4. **Turn budget 即节点预算。** 每个节点 turn（以及每次 `callStructured` retry）都会消耗当前 generation 的 `maxTurnSteps`；引擎兜底是 `TurnBudgetExceededError`。critique 边读取 `remainingTurns()`（来自 `PromptContext.usedTurnSteps`）来 **优雅降级**：当预算不足时交付当前 draft，而不是在图中途失败。

## 运行

在 `examples` 根目录下：

```bash
pnpm start -- --module=graph-policy
```

运行会打印图路径、revise 次数、每个中间 draft/revision、每轮 critic 反馈，以及最终通过验证的 draft。

## 非目标

这个示例展示的是“图作为推理策略”的层级。完整的 LangGraph-like 产品（agent-level nodes、interrupt/resume、threads）应该放在 Agent 之上的编排层；如果想看子 Agent 风格的 fan-out，请参考 `fan-in-fan-out`。
