# 介绍

Rejelly 是一个受 React 启发的 Agent 框架，将 Agent 视为带有 Hooks 的函数，用于构建 LLM 应用。

## 核心设计哲学

四条原则，下面的例子逐条兑现：

1. **Agent 即函数**：`createAgent` 包一个接收 `props` 的异步函数，输入进、结果出。
2. **Hook 式构建 Prompt**：`equip` 系列（system / instruction / tool / memory）就地聚合相关逻辑，告别散乱的字符串拼接与显式 `ctx` 参数（底层 AsyncLocalStorage）。
3. **契约式输出**：`promptAgent` 配合 Zod Schema 定义并校验 LLM 的输出结构，把"给动作"和"给思考过程"一起约束住。
4. **`reborn` 重建上下文**：跨轮次不把中间过程追加进对话历史，而是每轮用最新 Memory 重新渲染 Prompt——面向目标，每次都完整描述现状与意图。

## 一步步搭一个 Agent

从一个空壳开始，五步搭出一个会调研、能多轮迭代的 Agent。**每步只需看高亮的行**（新增或改动的部分）。

### 1. 骨架：Agent 就是一个函数

```ts
import { createAgent } from '@rejelly/core';

// openaiModel 是一个模型适配器，如何构造见「适配器」文档
export const Researcher = createAgent({
  id: 'researcher',
  model: openaiModel,
  handler: async ({ topic }) => {
    return `TODO: 研究 ${topic}`;
  },
});
```

`createAgent` 包一个接收 `props`（这里是 `{ topic }`）的异步函数，输入进、结果出——和调用普通函数一样：`await Researcher({ topic: '...' })`。

### 2. 会说话：用 Hook 写 Prompt

```ts
import { createAgent, equipSystem, equipInstruction } from '@rejelly/core'; // [!code highlight]

export const Researcher = createAgent({
  id: 'researcher',
  model: openaiModel,
  handler: async ({ topic }) => {
    equipSystem('你是一个具有批判性思维的高级研究员。'); // [!code highlight]
    equipInstruction(`请就主题「${topic}」写一份研究报告。`); // [!code highlight]
    return `TODO: 研究 ${topic}`;
  },
});
```

`equip` 系列就地构建 Prompt——`equipSystem` 定人设、`equipInstruction` 给任务。不用字符串拼接，也不用传 `ctx`（当前 Agent 由底层 AsyncLocalStorage 隐式提供）。

### 3. 能跑：契约式输出

```ts
import { createAgent, equipSystem, equipInstruction, promptAgent } from '@rejelly/core'; // [!code highlight]
import { z } from 'zod'; // [!code highlight]

export const Researcher = createAgent({
  id: 'researcher',
  model: openaiModel,
  handler: async ({ topic }) => {
    equipSystem('你是一个具有批判性思维的高级研究员。');
    equipInstruction(`请就主题「${topic}」写一份研究报告。`);

    return await promptAgent(z.object({ // [!code highlight]
      report: z.string().describe('研究报告正文'), // [!code highlight]
    })); // [!code highlight]
  },
});
```

`promptAgent` 调用 LLM，Zod Schema 既定义输出结构、又负责校验；若 LLM 的输出不合规，框架会带着错误信息自动重试。到这里已经是一个**可用的单轮 Agent**，返回值类型就是 `{ report: string }`。

### 4. 会用工具：equipTool

```ts
import { createAgent, equipSystem, equipInstruction, equipTool, promptAgent } from '@rejelly/core'; // [!code highlight]
import { z } from 'zod';

export const Researcher = createAgent({
  id: 'researcher',
  model: openaiModel,
  handler: async ({ topic }) => {
    equipSystem('你是一个具有批判性思维的高级研究员。');

    equipTool({ // [!code highlight]
      name: 'search', // [!code highlight]
      description: '搜索网络获取信息', // [!code highlight]
      parameters: z.object({ query: z.string() }), // [!code highlight]
      handler: async ({ query }) => `关于「${query}」的资料…`, // [!code highlight]
    }); // [!code highlight]

    equipInstruction(`请就主题「${topic}」写一份研究报告，可用 search 工具补充资料。`); // [!code highlight]

    return await promptAgent(z.object({
      report: z.string().describe('研究报告正文'),
    }));
  },
});
```

注册工具后，LLM 在 `promptAgent` 内部**自行决定**是否调用；框架自动执行 `handler`、把结果回灌给 LLM，你不用手写调用循环。

### 5. 多轮、面向目标：equipMemory + reborn

单轮工具调用之外，很多任务需要**跨轮迭代**：调研一点、评估缺口、再调研。这时不要把历史对话越堆越长，而是用 `reborn` 每轮重建 Prompt，用 `equipMemory` 让状态跨轮存活。

```ts
import { createAgent, equipSystem, equipInstruction, equipTool, equipMemory, promptAgent, reborn } from '@rejelly/core'; // [!code highlight]
import { z } from 'zod';

export const Researcher = createAgent({
  id: 'researcher',
  model: openaiModel,
  handler: async ({ topic }) => {
    // 跨 reborn 存活的记忆：reborn 重跑后返回上一轮更新后的值，而非初始值 // [!code highlight]
    const [notes, setNotes] = equipMemory<string[]>('notes', []); // [!code highlight]

    equipSystem('你是一个具有批判性思维的高级研究员。');

    equipTool({
      name: 'search',
      description: '搜索网络获取信息',
      parameters: z.object({ query: z.string() }),
      handler: async ({ query }) => `关于「${query}」的资料…`,
    });

    // Prompt 是「状态的函数」：把当前情报渲染成看板，而不是堆历史对话 // [!code highlight]
    const board = notes.length ? notes.join('；') : '（暂无情报）'; // [!code highlight]
    equipInstruction(`主题：${topic}。已有情报：${board}。情报不足就继续调研，已成闭环就产出最终报告。`); // [!code highlight]

    // 契约式决策：让 LLM 在「继续调研」和「收尾」之间二选一 // [!code highlight]
    const decision = await promptAgent( // [!code highlight]
      z.discriminatedUnion('action', [ // [!code highlight]
        z.object({ // [!code highlight]
          action: z.literal('continue'), // [!code highlight]
          finding: z.string().describe('本轮借助工具获得的新情报'), // [!code highlight]
        }), // [!code highlight]
        z.object({ // [!code highlight]
          action: z.literal('finish'), // [!code highlight]
          report: z.string().describe('最终研究报告'), // [!code highlight]
        }), // [!code highlight]
      ]), // [!code highlight]
    ); // [!code highlight]

    // 继续：把本轮情报存进 memory，再 reborn 带着它重跑、刷新看板 // [!code highlight]
    if (decision.action === 'continue') { // [!code highlight]
      setNotes([...notes, decision.finding]); // [!code highlight]
      return reborn(); // [!code highlight]
    } // [!code highlight]

    return decision.report; // [!code highlight]
  },
});
```

`reborn()` 结束当前这一代、带着更新后的 `notes` 重跑 handler——`equip*` 全部从最新状态重新收集，看板随之刷新。这就是**面向目标**：每轮都完整描述现状与意图，而非把中间过程无限追加进对话历史。只有显式存进 memory 的情报才会进入下一轮，噪音被自然丢弃。

## 下一步

- 使用 [Create Rejelly](/zh/guide/create) 从零生成项目
- 使用 [DevTool](/zh/guide/devtool) 可视化调试 Agent Trace
- 在现有项目中直接安装适配器包（如 `pnpm add @rejelly/adapter-openai`）
- 阅读 [API 文档](/zh/api/) 了解完整的 API
- 读一个复杂 Agent 实例：[evil-jelly](https://github.com/waht41/rejelly/tree/main/apps/evil-jelly)——文件系统工具 + MCP + CLI 的完整源码
