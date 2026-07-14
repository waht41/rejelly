简体中文 | [English](./README.md)

<div align="center">

# Rejelly

**像写 React 一样写 Agent —— Agent 即函数,用 Hooks 搭建 Prompt。**

[![npm](https://img.shields.io/npm/v/%40rejelly%2Fcore?label=%40rejelly%2Fcore)](https://www.npmjs.com/package/@rejelly/core)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](#开发与贡献)

</div>

Rejelly 是一个受 React 启发的 Agent 框架:把 Agent 当作**接收 props 的函数**,用 **Hooks** 就地搭建 Prompt，用 **Zod 契约**约束模型输出。面向构建 LLM 应用。

## 为什么是 Rejelly

- **Agent 即函数** —— `createAgent` 包裹一个 async 函数，input 进、result 出，像调用普通函数一样调用它。
- **用 Hooks 搭 Prompt** —— `equip` 家族（system / instruction / tool / memory）就地聚合相关逻辑，告别散落的字符串拼接和显式 `ctx` 传递（底层由 AsyncLocalStorage 支撑）。
- **契约驱动输出** —— `promptAgent` 配 Zod Schema 定义并校验模型输出结构；不符合时框架带着错误反馈自动重试。
- **`reborn` 重建上下文** —— 每一轮以最新 Memory 重新渲染 Prompt，而非跨轮追加历史，始终面向当前状态与意图。

## 快速开始

```bash
# 最快路径：脚手架（交互式，依次询问项目名 / 模板 / 模型适配器）
npm create rejelly@latest

# 或手动安装核心 + 一个模型适配器
npm install @rejelly/core @rejelly/adapter-openai zod
```

脚手架完成后按提示进入项目：`cd <项目名> && pnpm install`，编辑 `.env` 填入 API Key，再 `pnpm start`。

一个可用的单轮 Agent 长这样：

```ts
import { createAgent, equipSystem, equipInstruction, promptAgent } from '@rejelly/core';
import { z } from 'zod';

// openaiModel 是模型适配器 —— 构造方式见适配器文档
const Researcher = createAgent({
  id: 'researcher',
  model: openaiModel,
  handler: async ({ topic }) => {
    equipSystem('You are a senior researcher with critical thinking.');
    equipInstruction(`Please write a research report on the topic "${topic}".`);

    return await promptAgent(z.object({
      report: z.string().describe('Research report body'),
    }));
  },
});

const { report } = await Researcher({ topic: 'state of agent frameworks' });
```

完整的分步教程（补工具、多轮、reborn）见文档：

📖 **[中文文档](./docs/zh/guide/index.md)** · [API 参考](./docs/zh/api/index.md) · [English docs](./docs/en/guide/index.md)

## 调试与可观测性（DevTool）

**DevTool** 是 Rejelly 的本地调试工具：接收、存储、查看 Agent 运行时的 **Trace**，内置本地 Server、可视化 UI、HTTP API、MCP 工具，以及可选的 AI 辅助分析。在要调试的项目里装为 dev 依赖：

```bash
pnpm add -D @rejelly/devtool
```

配合 `@rejelly/core` 的 **Time Travel**（快照 / 事件回放：`dumpSnapshot` · `restoreSnapshot` · `runWith`，见 `@rejelly/core/debugger`），可在本地复现并逐步回放一次运行——生产环境采集 Trace，事后重建快照调试。详见 **[DevTool 指南](./docs/zh/guide/devtool.md)** 与 **[Time Travel](./docs/zh/api/time-travel.md)**。

## 仓库地图

这是一个 pnpm + turbo 的 monorepo。面向用户的包：

| 包 | 说明 |
|------|------|
| [`@rejelly/core`](./packages/core) | 核心框架：`createAgent` / `equip` 家族 / `promptAgent` / `reborn`。 |
| [`@rejelly/adapter-openai`](./packages/adapters) · `-gemini` · `-langchain` · `-mcp` | 模型与工具适配器。 |
| [`@rejelly/limit-model`](./packages/limit-model) | 模型适配器限流中间件（TPM / RPM / 并发，内存或 Redis 存储）。 |
| [`create-rejelly`](./packages/create) | `npm create rejelly` 脚手架，几秒起一个 Rejelly 应用。 |
| [`@rejelly/devtool`](./apps/devtool-server) | 本地调试工具：采集 / 存储 / 查看运行时 Trace，内置 Server + UI + HTTP API + MCP。 |

示例（每个都带双语 README）：**[`examples/`](./examples)** — `01-basics` · `02-patterns` · `03-advanced`。

参考应用（self-hosting / dogfooding）：**[`apps/evil-jelly`](./apps/evil-jelly)**（已发布为 `@rejelly/evil-jelly`）— 用 Rejelly 造的终端编码 Agent CLI：对话式改代码（写盘前 diff 确认）、命令执行、随手 web 检索，外加只读的代码 / 文档审计（`evil audit`）。它既是框架用于真实规模应用的**参考实现**，也是本仓库拿框架迭代框架自身的**自迭代工具**——想看 Rejelly 造出来长什么样，从它上手。

> 其余为内部包，不作为用户 API：`jelly-lint`（架构边界治理）、`devtool-ui` / `devtool-contracts`（DevTool 的内置 UI 与共享契约）、`env`、`ink`（fork）、`test-utils`、`release-tools` 等。

## 开发与贡献

前置：**Node ≥ 18**、**pnpm 10**（仓库固定 `pnpm@10.28.2`）。`jelly-lint` 是 Rust CLI，跑 `pnpm build` / `pnpm lint:jelly` 会用 `cargo` 构建它，需先装 **Rust 工具链（cargo）**（见 [rustup.rs](https://rustup.rs)）。

```bash
pnpm install         # 安装全部工作区依赖
pnpm build           # turbo 构建所有包
pnpm typecheck       # 全量类型检查
pnpm test            # 运行测试
pnpm lint:jelly      # jelly-lint（Rust CLI，需 cargo）校验架构依赖边界
pnpm check           # typecheck + lint + biome 一把梭
```

架构依赖方向由 `jelly-lint` 声明式约束（配置见仓库根 `jellylint.json[c]`），只能向下引用。改动跨包边界前先跑 `pnpm lint:jelly`。

## License

[Apache-2.0](./LICENSE)
