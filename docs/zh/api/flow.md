# Flow (控制流)

这是 async handler 的返回值或中断操作。

## 调用子 Agent

直接调用子 Agent 函数，等待其返回结果。_父子关系：_ 栈式调用（Stack）。

```typescript
// 直接调用子 Agent
const result = await ChildAgent({ query: 'hello' });

// 在父 Agent 中调用子 Agent
handler: async (props) => {
  equipSystem('你是协调者');
  
  // 调用搜索 Agent
  const searchResult = await SearchAgent({ query: props.query });
  
  // 调用分析 Agent
  const analysis = await AnalyzeAgent({ data: searchResult });
  
  return { searchResult, analysis };
}
```

## `reborn(newProps?)`

**重载指令**。立即结束当前函数执行，并**保留当前 `equipMemory` 的状态**，重新运行 `handler`。可传递新的 `newProps`，如果不传则沿用旧的。

**注意**：Memory 更新应通过 `equipMemory` 的 `setState` 函数在调用 `reborn()` 之前完成，而不是通过 `reborn` 参数。

```typescript
// 更新 memory 然后 reborn
const [attempts, setAttempts] = equipMemory('attempts', 0);
setAttempts(attempts + 1);
return reborn(); // 使用当前 props

// 更新 props 并 reborn
return reborn({ topic: 'new topic', retry: true });

// 只更新 props，不更新 memory
return reborn({ attempt: props.attempt + 1 });
```

## `return result`

结束当前 Agent 任务，将结果返回给调用者（父 Agent 或用户）。
