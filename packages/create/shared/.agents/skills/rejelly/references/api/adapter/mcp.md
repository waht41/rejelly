# MCP (Model Context Protocol) Adapter

`@rejelly/adapter-mcp` provides `equipMCP` and `fromMCPTool`. It does not create transports or processes — instead, it receives an already-connected MCP Client from the business layer and converts MCP tools, resources, and prompt capabilities into Rejelly-compatible toolkits.

For the receive-side contract of multimodal tool results, see [Adapter · Multimodal Tool Results](/en/api/adapter/#multimodal-tool-results).

## `equipMCP(client, options)`

**MCP bridging Hook.** Does not create transports or processes inside the adapter — you establish the connection outside the Agent using the official `@modelcontextprotocol/sdk` (or another implementation), then pass the **already connected client** to `equipMCP`. The adapter handles JSON Schema → Zod, assembles `MCPKit`, and caches `tools/list` via `equipMemo` (avoiding RPC on every `reborn()` round). **`kit.inject()`** calls `equipTool` to register with the current Agent.

**Recommended combination:**

1. `equipResource('mcp:…', { create, destroy, expose })` — connection lifecycle and sub-agent exposure (see [equipResource](/en/api/equip#equipresource)).
2. `const kit = await equipMCP(client, { clientId, … })` — fetches and converts tool definitions; then `kit.inject()` calls `equipTool` to register with the current Agent.

**Example (stdio + official SDK):**

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { equipMCP } from '@rejelly/adapter-mcp';
import { equipResource, promptAgent } from '@rejelly/core';

const client = await equipResource('mcp:fs', {
  create: async () => {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
    });
    const c = new Client({ name: 'app', version: '1.0.0' });
    await c.connect(transport);
    return c;
  },
  destroy: async (c) => { await c.close(); },
  deps: ['/data'],
  expose: true,
});

const kit = await equipMCP(client, {
  clientId: 'fs-main',
  namespace: 'fs',
  enableResources: true,
});
kit.inject({ injectResourceTools: true });

const result = await promptAgent(ResultSchema);
```

**Standalone conversion (single tool):** The exported function `fromMCPTool(mcpTool, client, { name? })` can convert a single MCP Tool into `ToolDefinition`, useful for custom composition or testing.

**MCPKit:** `equipMCP` returns `client`, `tools` (MCP business tools only), `resourceTools` (composite tools for `list_resources` / `read_resource`), `toolMap`, `resourceToolMap`, `prompts` (`list` / `get` + **`asInstruction()`**, returns `MessageContent` that can be passed directly to `equipInstruction`), and `inject`. Calling **`inject({ injectTools?, injectResourceTools?, middleware? })`** triggers `equipTool`: default is **`injectTools: true`**, **`injectResourceTools: false`** (to avoid cluttering the Prompt with resource URIs; enable when needed). **The `kit.tools` returned by `await equipMCP(...)` is the snapshot from this fetch/cache parse** — it won't silently change later. To get the latest list, pass **`forceRefresh: true`** on the **next** `equipMCP` call (see below).

**Naming contract:** Names in `options.tools` **always use the original MCP server tool names** (for filtering and `callTool`); **`namespace`** only affects the name registered to the Agent / LLM side (avoids `read_file` name collisions when multiple MCPs coexist). If `tools` are declared but cannot all be found within pagination and `maxItems`, the adapter **throws** (Fail Fast), preventing calls to the model with an incomplete tool set.

**Force refresh list (declarative):** `forceRefresh: true` means **this** `equipMCP` call **skips the tools/list memo**, re-fetches from the MCP server, and **writes back** to the `equipMemo` cache (by advancing the list epoch). Use this when you know the server's tool set has changed, or when you want **every** `equipMCP` call to re-`listTools` (pass `forceRefresh: true` each time).

## EquipMCPOptions Interface

```typescript
interface EquipMCPOptions {
  clientId: string;
  /** Namespace for tool names registered to the Agent; `tools` filtering still uses MCP native names */
  namespace?: string;
  tools?: string[];
  /** Skip memo this round, re-listTools and overwrite the cache */
  forceRefresh?: boolean;
  /** Whether to follow listTools nextCursor to fetch all pages, default true */
  autoPaginate?: boolean;
  /** Maximum number of Tool items to collect (guard), default 100 */
  maxItems?: number;
  /**
   * When true, generates synthetic list/read resource tools in `resourceTools` (unrelated to ClientCapabilities in the MCP protocol).
   */
  enableResources?: boolean;
  middleware?: ToolMiddleware[];
}
```

**MCPClientAdapter (Facade):** Different from the official `@modelcontextprotocol/sdk` `Client` type; a simplified contract for Rejelly. `inputSchema` retains the server's JSON Schema; `callTool`'s `content` supports `text` / `image` / `audio` / `resource` blocks; `isError` follows the protocol. Optional methods align with the SDK at runtime (e.g., `getPrompt` typically accepts a single object parameter).

## How It Works

1. **Connection**: You `connect` the official Client inside [equipResource](/en/api/equip#equipresource)'s `create`; `close` in `destroy`.
2. **Tools**: `listTools` supports `nextCursor` via `autoPaginate` + `maxItems`; if `tools` (native name list) is configured but cannot all be found within pagination and limits, **throws immediately**; results are cached via `equipMemo` by default (same `clientId` and deps — `reborn()` doesn't repeat RPC); **`forceRefresh: true`** skips cache hit and refreshes; generates a `ToolDefinition` for each MCP tool (JSON Schema goes directly into `jsonSchemaToZod`); registers when **`kit.inject({ injectTools: true })`** is called.
3. **Invocation**: `callTool` is compatible with both the SDK's `callTool({ name, arguments })` and `(name, args)` signatures; plain text results are returned as text; non-text blocks (including images) are converted to `toolContent` (see [Adapter · Multimodal Tool Results](/en/api/adapter/#multimodal-tool-results)).
4. **Resources**: When **`enableResources`** is true, generates **`resourceTools`** (`list_resources` with cursor, `read_resource` by URI) — **not fully listed at equip time**; only registered via **`inject({ injectResourceTools: true })`**.
5. **Prompts**: `kit.prompts.list()` / `get()` let you manually `equipInstruction` in your business logic; `get` returns an object with **`asInstruction()`** (`MessageContent`: `string | ContentPart[]`, including text / image / video, consistent with `@rejelly/core` definitions).

## Working with equipResource

- Typical pattern: `await equipResource('mcp:<name>', { create, destroy, deps, expose: true })` for a long-lived Client, then `await equipMCP(client, { clientId, … })` to get `kit`, and finally `kit.inject()`.
- For sub-agents that need to use the same connection directly in code, use [expectResource](/en/api/expect#expectresource): **`expectResource<MCPClientAdapter>('mcp:<name>')`**, the key must exactly match the parent's `equipResource` key (including the `mcp:` prefix).

**Notes:**

- Before a sub-agent can read a parent-exposed Client, the parent Agent must have already called `equipResource('mcp:…', { expose: true })` and **completed registration before** the sub-agent executes.
- To bypass memo and re-`listTools` each time, pass **`forceRefresh: true`** (can be passed on every `equipMCP` call).
- The official SDK's `readResource` is often `readResource({ uri })`, which may not match the `MCPClientAdapter` doc signature — adapt or assert types on the business side as needed.

## Parent-Child Agent Example (Child Uses `expectResource`)

```typescript
import type { MCPClientAdapter } from '@rejelly/adapter-mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { equipMCP } from '@rejelly/adapter-mcp';
import { createAgent, equipResource, expectResource, equipScope, expectScope, promptAgent } from '@rejelly/core';
import { z } from 'zod';

const ParentAgent = createAgent({
  id: 'parent',
  handler: async () => {
    const fsClient = await equipResource('mcp:filesystem', {
      create: async () => {
        const t = new StdioClientTransport({
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        });
        const c = new Client({ name: 'app', version: '1.0.0' });
        await c.connect(t);
        return c;
      },
      destroy: async (c) => { await c.close(); },
      deps: ['/tmp'],
      expose: true,
    });

    const kit = await equipMCP(fsClient, { clientId: 'fs', namespace: 'filesystem' });
    kit.inject();

    equipScope({ workspace: '/tmp' });

    return await ChildAgent({ task: 'analyze' });
  },
});

const ChildAgent = createAgent({
  id: 'child',
  handler: async () => {
    const { workspace } = expectScope(z.object({ workspace: z.string() }));
    const fsClient = expectResource<MCPClientAdapter>('mcp:filesystem');
    const config = await fsClient.readResource(`file://${workspace}/config.json`);
    const configData = JSON.parse(config.contents[0].text as string);
    equipInstruction(`Working directory: ${workspace}\nConfiguration: ${JSON.stringify(configData)}`);
    return await promptAgent(ResultSchema);
  },
});
```
