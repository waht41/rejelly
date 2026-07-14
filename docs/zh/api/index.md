# Rejelly API Documentation

> 设计理念见 [指南 · 介绍](/zh/guide/)；本页是按**生命周期阶段**组织的 API 地图。

## API 文档结构

Rejelly 的 API 按照 **生命周期阶段** 组织，遵循清晰的执行流程：

### 1. [Core (核心定义)](/zh/api/core)
- `createAgent` - 定义 Agent
- `promptAgent` - 调用 LLM
- `ModelAdapter` - 模型适配器接口
- `dumpSnapshot` / `restoreSnapshot` / `runWith` - 快照与恢复
- `augmentModel` / `augmentTool` / `augmentAgent` - 增强机制（模型 / 工具 / Agent）
- `callTool` - 手动调用单个工具（不经过模型 tool-call loop）

### 2. [Equip (输入与上下文)](/zh/api/equip)
- `equipSystem` / `equipInstruction` - Prompt 构建
- `equipMemory` / `equipMemo` - Agent 内存（单次 invocation 内，跨 `reborn`，Agent 返回即销毁）
- `equipResource` - 资源管理
- `equipTool` - 工具注册
- `equipBudget` / `equipScope` - 预算与作用域
- `equipTraceAttr` - trace添加attr
- [Budget 机制](/zh/api/budget) - 预算控制与使用统计

### 3. [Adapter (适配器)](/zh/api/adapter/)
- [Model Adapter](/zh/api/adapter/model) - OpenAI / Gemini 模型适配、`schemaMode` 与 provider 配置
- [MCP](/zh/api/adapter/mcp) - `equipMCP` / `MCPKit` / 资源工具 / 父子 Agent 暴露
- [LangChain](/zh/api/adapter/langchain) - `fromLangChainTool`
- [Limit Model (限流)](/zh/api/limit-model) - `withLimit` / `withSimpleLimit` 模型限流中间件、MemoryStore / RedisStore
- [多模态工具结果](/zh/api/adapter/#多模态工具结果-multimodal-tool-results) - model adapter 发送侧与工具 adapter 接收侧的共享契约

### 4. [Expect (输出与验证)](/zh/api/expect)
- `expectValidator` - 自定义验证
- `expectScope` / `expectResource` - 依赖声明

### 5. [Effect (副作用)](/zh/api/effect)
- `onStream` - Agent 级流式事件监听

### 6. [Flow (控制流)](/zh/api/flow)
- `reborn` - 重载指令
- 调用子 Agent

### 7. [Policy (自定义策略)](/zh/api/policy)
- `createAgentPolicy` - 自定义 policy 工厂（prompt 生命周期、telemetry、Runtime Seal）
- `executeTurn` / `executeTools` / `executeValidation` - 执行原语（policy 内部专用）
- `executeValidatedLoopTurn` / `transferJsonSchema` - 预设循环的组合件
- 以上均从独立子路径 `@rejelly/core/policy` 导入

### 8. [Testing (测试工具)](/zh/api/testing)
- `createMockModel` - 创建 Mock Model
- Mock Model API - 规则配置、调用记录

### 9. [Debug (调试与可观测性)](/zh/api/debug)
- Console Logger - 控制台日志
- File Logger - 文件日志
- OTLP Exporter - 分布式追踪
- Review Exporter - 实时追踪可视化
- `withCustomSpan` - 手动追踪 span

---

## 快速开始

```typescript
import { createAgent, equipSystem, equipInstruction, promptAgent } from '@rejelly/core';
import { z } from 'zod';

const MyAgent = createAgent({
  id: 'my_agent',
  handler: async (props) => {
    equipSystem('你是一个助手');
    equipInstruction(`任务：${props.task}`);
    
    const ResultSchema = z.object({ answer: z.string() });
    return await promptAgent(ResultSchema);
  }
});

const result = await MyAgent({ task: '回答一个问题' });
```

---

## 核心机制

### 验证重试机制 (Self-Correction)

当 `promptAgent(schema)` 的 Schema 校验或 `expectValidator` 校验失败时，框架会自动进行 Self-Correction 重试：

```
LLM 输出 → 验证 → 失败 → 拼接错误提示到 prompt → 重新调用 LLM → 验证 → ...
                         ↓
                   重试次数耗尽
                         ↓
              抛出 AttemptsExhaustedError
```

### Reborn 机制：跨轮次重建上下文

当一次 Agent 需要进入下一轮推理时，推荐用 `return reborn()` 结束当前 Generation 并重新运行 handler。这样 `equipSystem` / `equipInstruction` / `equipTool` 等 draft 会从最新状态重新收集，Prompt 自然刷新。

如果只是在同一次 handler 执行里手写循环并反复处理历史消息，容易退回到 append-only 的对话模式：上下文越来越长，Prompt 构建逻辑也会分散到循环分支里。

`reborn()` 返回一个带有特殊 Symbol 标记的对象（`RebornSignal`），框架通过 `isRebornSignal()` 检查返回值来判断是否需要重新运行。

## 调用顺序约束

**必须在 `promptAgent()` 之前调用的函数：**

- `equipSystem()` - 必须在 promptAgent 之前
- `equipInstruction()` - 必须在 promptAgent 之前
- `equipTool()` - 必须在 promptAgent 之前
- `equipBudget()` - 必须在 promptAgent 之前
- `expectValidator()` - 必须在 promptAgent 之前
- `onStream()` - 必须在 promptAgent 之前

**不需要在 `promptAgent()` 之前调用的函数：**

- `equipScope()` - 必须在调用子 Agent 之前（与 promptAgent 无关）
- `equipTraceAttr()` - 可在 handler 内任意位置调用，用于给当前 agent/generation 的 span 打标（在 agent:end、generation:end 的 trace.attributes 中透出）
- `expectScope()` - 可在任何位置调用（用于读取父 Agent 提供的作用域）
- `expectResource()` - 可在任何位置调用（用于读取父 Agent 暴露的资源）
- `equipMemory()` / `equipMemo()` - 可在任何位置调用（Agent 内存：单次 invocation 内、跨 reborn，Agent 返回即销毁）

**原理**：
- **promptAgent 相关**：框架在调用 `promptAgent()` 时收集所有已配置的 equip/expect，构建完整的 Prompt 并发送给 LLM。在 `promptAgent()` 之后调用的这些函数不会生效。
- **子 Agent 相关**：`equipScope()` 用于为子 Agent 提供作用域，必须在调用子 Agent 之前调用，与 `promptAgent()` 无关。
- **读取依赖**：`expectScope()` 和 `expectResource()` 用于读取父 Agent 提供的作用域和资源，可以在任何位置调用（包括 promptAgent 之后）。跨 Agent / 跨 Session 的持久状态通过 `runWith({ providers })` 注入真实数据库、Redis 或 SDK 客户端，再用 `expectResource()` 读取。
