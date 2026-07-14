# MCP Integration (Model Context Protocol)

> [中文](README.zh-CN.md) | English

This example shows how to plug **Model Context Protocol (MCP)** servers into Rejelly using `@modelcontextprotocol/sdk` for the connection and `@rejelly/adapter-mcp` for tool bridging.

## Install and integrate

```bash
pnpm add @rejelly/adapter-mcp @modelcontextprotocol/sdk
```

## Core mechanisms

### 1. Connect outside, then `equipMCP`

Create a connected MCP `Client`, optionally hold it with `equipResource`, then build a kit and call `inject()`:

```typescript
import { equipMCP } from "@rejelly/adapter-mcp";
import { equipResource } from "@rejelly/core";
// create Client + StdioClientTransport, await client.connect(transport) ...

const client = await equipResource("mcp:filesystem", { create, destroy, deps, expose: true });
const kit = await equipMCP(client, { clientId: "fs", namespace: "fs" });
kit.inject({ injectResourceTools: true });
```

### 2. Parent–child sharing (`expose: true` + `expectResource`)

Only the parent opens the connection. Children reuse it with **`expectResource<MCPClientAdapter>('mcp:filesystem')`** — the key must match the parent’s `equipResource` key.

```typescript
import type { MCPClientAdapter } from "@rejelly/adapter-mcp";
import { expectResource } from "@rejelly/core";

const mcpClient = expectResource<MCPClientAdapter>("mcp:filesystem");
```

See `mcp-agent.ts` and [Adapter · MCP](/api/adapter) for full detail.

## Run the example

From the `examples` directory:

```bash
cd examples
pnpm start
```
