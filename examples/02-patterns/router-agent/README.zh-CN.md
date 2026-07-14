# Router 路由模式

> 中文 | [English](README.md)

本示例演示 **Router（路由）模式**：意图识别 + 分发。用 Zod 约束 LLM 输出结构化的路由决策，再用原生 TypeScript 的 `switch`/`if` 调用对应子 Agent，无需 Graph DSL，控制流即代码。

## 运行

在 `examples` 根目录下：

```bash
pnpm run start -- --module=router-agent --example=search
```

或在菜单中选择 **Router**，再选择要运行的用例（搜索 / 代码 / 闲聊）。

## 思路

1. **结构化路由决策**：用 `promptAgent` + Zod schema，让 LLM 返回 `{ route: 'search_expert' | 'code_expert' | 'casual_chat', reason: string }`。
2. **原生控制流分发**：用 `switch (decision.route)` 调用对应子 Agent。

```typescript
const decision = await promptAgent(z.object({
  route: z.enum(['search_expert', 'code_expert', 'casual_chat']),
  reason: z.string()
}));

switch (decision.route) {
  case 'search_expert':
    return await SearchAgent({ task: props.input });
  case 'code_expert':
    return await CodeAgent({ task: props.input });
  default:
    return await ChatAgent({ message: props.input });
}
```

子 Agent 保持极简：每个返回带 `agent` 标识（如 `SearchExpert`、`CodeExpert`、`ChatBot`）的结果，终端输出即可一眼看出请求被路由到了哪个专家。
