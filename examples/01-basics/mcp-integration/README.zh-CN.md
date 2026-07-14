# MCP Integration (模型上下文协议接入)

> 中文 | [English](README.md)

本示例展示如何用官方 `@modelcontextprotocol/sdk` 建立连接，并用 `@rejelly/adapter-mcp` 将 MCP 工具桥接到 Rejelly。

## 安装

```bash
pnpm add @rejelly/adapter-mcp @modelcontextprotocol/sdk
```

## 核心机制

### 1. 外部连接后再 `equipMCP`

在 Agent 外 `connect` MCP `Client`，可用 `equipResource` 托管生命周期，再 `equipMCP` 得到 `kit` 并 `inject()`：

```typescript
import { equipMCP } from "@rejelly/adapter-mcp";
import { equipResource } from "@rejelly/core";
// 创建 Client、StdioClientTransport，await client.connect(transport) …

const client = await equipResource("mcp:filesystem", { create, destroy, deps, expose: true });
const kit = await equipMCP(client, { clientId: "fs", namespace: "fs" });
kit.inject({ injectResourceTools: true });
```

### 2. 父子共享（`expose: true` + `expectResource`）

仅父 Agent 建立连接；子 Agent 用 **`expectResource<MCPClientAdapter>('mcp:filesystem')`** 取同一实例，key 必须与父级 `equipResource` 一致。

```typescript
import type { MCPClientAdapter } from "@rejelly/adapter-mcp";
import { expectResource } from "@rejelly/core";

const mcpClient = expectResource<MCPClientAdapter>("mcp:filesystem");
```

完整示例见 `mcp-agent.ts` 与 [Adapter · MCP](/api/adapter)。

## 运行

在 `examples` 目录下：

```bash
cd examples
pnpm start
```
