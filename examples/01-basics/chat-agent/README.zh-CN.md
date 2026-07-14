# Chatty Agent (多轮对话客服示例)

> 中文 | [English](README.md)

这个示例展示了如何使用 Rejelly 优雅地构建**多轮对话系统**。

与传统的 `while(true)` 外部循环不同，本示例将对话流和状态管理完全内聚在 Agent 内部，利用 `reborn` 和 `equipMemory` 实现了清晰的“状态机”式对话循环。

## 💡 核心机制

1. **Agent 内部中断/等待输入**：直接在 `handler` 内 `await userInput()` 挂起执行，等待外部真实输入（终端、WebSocket 或 API）。
2. **跨轮次记忆 (Memory)**：使用 `equipMemory` 声明并持久化对话历史 (`conversation_history`)，状态在 `reborn` 后自动恢复，无需手动在外部维护全局变量。
3. **基于目标的循环 (Reborn)**：完全抛弃 `while` 循环。完成一轮对话并更新 Memory 后，通过 `return reborn()` 重启 Agent。每次执行都会基于最新的 Memory 渲染最干净的 Prompt，避免上下文污染。

## 🔄 范式对比

### ❌ 传统方式：外置循环 + 手动堆砌历史

```typescript
let history = [];

// 外部控制流，逻辑割裂，Prompt 随着循环不断膨胀
while (true) {
  const input = await getUserInput();
  history.push({ role: 'user', content: input });
  
  const prompt = `History: ${history.join('\n')}`;
  const response = await callLLM(prompt);
  history.push({ role: 'assistant', content: response });
  
  if (isSatisfied) break;
}

```

### ✅ Rejelly 方式：内聚状态机 + Reborn

```typescript
handler: async () => {
  // 1. 声明记忆（跨重生保留）
  const [history, setHistory] = equipMemory('history', []);
  
  // 2. 等待外部输入
  const userMessage = await userInput();
  
  // 3. 历史与最新输入作为真实对话 Message 传入
  const { data: decision } = await promptChat({
    message: [...history, { role: 'user', content: userMessage }],
    schema: ResponseSchema,
  });
  
  // 4. 更新记忆状态
  setHistory([...history, userMessage, decision.response]);
  
  // 5. 状态流转：结束或重启
  if (decision.isSatisfied && !decision.shouldContinue) {
    return decision; // 结束对话
  }
  
  return reborn(); // 带着新状态，重新执行 handler (下一轮)
}

```

## 📂 目录结构

```text
chatty-customer-service/
├── types.ts                  # 接口与类型定义
├── chatty-agent.ts           # Chatty Agent 核心业务逻辑
├── index.ts                  # 运行入口与模拟数据
└── README.md                 # 文档

```

## 🚀 运行示例

在 `examples` 目录下执行脚本，在交互菜单中选中本示例（ `Chat Agent`）即可运行：

```bash
cd examples
pnpm start
```
