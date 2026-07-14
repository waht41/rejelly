# 示例索引

仓库内可运行示例集中在 [`examples/`](https://github.com/waht41/rejelly/tree/main/examples) 目录，按难度分为 **01-basics**、**02-patterns**、**03-advanced**。以下为简要说明与对应代码位置（GitHub：<https://github.com/waht41/rejelly>）。

## 01 · 基础

| 说明 | 代码位置 |
| --- | --- |
| **Chat Agent**：多轮对话客服式流程；在 Agent 内用 `reborn` + `equipMemory` 管理会话状态，让每轮 Prompt 从当前状态重建。 | [`examples/01-basics/chat-agent/`](https://github.com/waht41/rejelly/tree/main/examples/01-basics/chat-agent) · 入口 [`index.ts`](https://github.com/waht41/rejelly/blob/main/examples/01-basics/chat-agent/index.ts) |
| **Multi-model Agent**：多模态输入（图文/视频）；通过 `equipInstruction` 传入结构化 `ContentPart[]`。 | [`examples/01-basics/multi-model-agent/`](https://github.com/waht41/rejelly/tree/main/examples/01-basics/multi-model-agent) · 核心 [`multi-model-agent.ts`](https://github.com/waht41/rejelly/blob/main/examples/01-basics/multi-model-agent/multi-model-agent.ts) |
| **MCP Integration**：通过 `@rejelly/adapter-mcp` 接入 MCP Server，与 `equipResource` / `equipMCP` 配合。 | [`examples/01-basics/mcp-integration/`](https://github.com/waht41/rejelly/tree/main/examples/01-basics/mcp-integration) · 入口 [`index.ts`](https://github.com/waht41/rejelly/blob/main/examples/01-basics/mcp-integration/index.ts) |

## 02 · 模式

| 说明 | 代码位置 |
| --- | --- |
| **Router**：意图识别 + Zod 结构化路由决策，再用原生 `switch` 分发子 Agent。 | [`examples/02-patterns/router-agent/`](https://github.com/waht41/rejelly/tree/main/examples/02-patterns/router-agent) · 逻辑 [`router-agent.ts`](https://github.com/waht41/rejelly/blob/main/examples/02-patterns/router-agent/router-agent.ts) |
| **Coding Agent**：沙箱工作区内 探索 → 编辑 → 运行 → 验证 的最小 coding agent；文件/shell 工具是原生 `ToolDefinition` 对象，日志与人工审批作为 tool middleware 按工具挂载（只读放行、写入过闸），单次 `promptChat` 驱动完整工具循环。 | [`examples/02-patterns/coding-agent/`](https://github.com/waht41/rejelly/tree/main/examples/02-patterns/coding-agent) · 核心 [`coding-agent.ts`](https://github.com/waht41/rejelly/blob/main/examples/02-patterns/coding-agent/coding-agent.ts)、工具 [`tools.ts`](https://github.com/waht41/rejelly/blob/main/examples/02-patterns/coding-agent/tools.ts) |
## 03 · 进阶

| 说明 | 代码位置 |
| --- | --- |
| **Fan-in / Fan-out**：并行多个 Worker Agent（`Promise.all`），再汇总到单一 Summarizer。 | [`examples/03-advanced/fan-in-fan-out/`](https://github.com/waht41/rejelly/tree/main/examples/03-advanced/fan-in-fan-out) · 入口 [`index.ts`](https://github.com/waht41/rejelly/blob/main/examples/03-advanced/fan-in-fan-out/index.ts) |
| **Time-travel**：`dumpSnapshot` / `restoreSnapshot` 与 trace 回放（无额外 LLM 调用的复现路径）。 | [`examples/03-advanced/time-travel/`](https://github.com/waht41/rejelly/tree/main/examples/03-advanced/time-travel) · [`dump-example.ts`](https://github.com/waht41/rejelly/blob/main/examples/03-advanced/time-travel/dump-example.ts)、[`restore-example.ts`](https://github.com/waht41/rejelly/blob/main/examples/03-advanced/time-travel/restore-example.ts) |
| **Graph Policy**：LangGraph 风格的 writer–critic 图（类型化 state、条件边、环、critic 并发 fan-out）实现为自定义 prompt policy；基于 `createAgentPolicy` + `executeTurn` + `executeValidation`，core 对 graph 零感知，并用 `usedTurnSteps` 在预算不足时优雅降级。 | [`examples/03-advanced/graph-policy/`](https://github.com/waht41/rejelly/tree/main/examples/03-advanced/graph-policy) · runtime [`graph-policy.ts`](https://github.com/waht41/rejelly/blob/main/examples/03-advanced/graph-policy/graph-policy.ts)、具体图 [`writer-critic-agent.ts`](https://github.com/waht41/rejelly/blob/main/examples/03-advanced/graph-policy/writer-critic-agent.ts) |

## 共享与运行

| 说明 | 代码位置 |
| --- | --- |
| **共享模型与定价**：示例共用的 OpenAI 适配器、`calculateCost` 与 `model-pricing` 表。 | [`examples/shared/`](https://github.com/waht41/rejelly/tree/main/examples/shared) · 如 [`openai-model.ts`](https://github.com/waht41/rejelly/blob/main/examples/shared/openai-model.ts)、[`model-pricing.ts`](https://github.com/waht41/rejelly/blob/main/examples/shared/model-pricing.ts) |
| **统一启动脚本**：按模块名选择示例（与 README 中 `pnpm run start` 一致）。 | [`examples/scripts/run.ts`](https://github.com/waht41/rejelly/blob/main/examples/scripts/run.ts) |

各子目录下的 `README.md`（部分含 `README.zh-CN.md`）有运行命令与机制详解；本地请在 **`examples/`** 根目录安装依赖后按对应 README 执行。
