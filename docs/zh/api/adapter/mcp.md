# MCP (Model Context Protocol) 适配器

`@rejelly/adapter-mcp` 提供 `equipMCP` 与 `fromMCPTool`。它不创建传输或进程，而是接收业务侧已经连接好的 MCP Client，并把 MCP 工具、资源与 prompt 能力转换成 Rejelly 可用的工具包。

多模态工具结果的接收侧契约见 [Adapter · 多模态工具结果](/zh/api/adapter/#多模态工具结果-multimodal-tool-results)。

## `equipMCP(client, options)`

**MCP 桥接 Hook**。不在适配器内创建传输或进程：由你在 Agent 外部使用官方 `@modelcontextprotocol/sdk`（或其它实现）建立连接，再把**已 connect 的 client** 交给 `equipMCP`。适配器负责 JSON Schema → Zod、组装 `MCPKit`，并通过 `equipMemo` 缓存 `tools/list`（避免 `reborn()` 每轮都打 RPC）；**`kit.inject()`** 时才调用 `equipTool` 注册到当前 Agent。

**推荐组合：**

1. `equipResource('mcp:…', { create, destroy, expose })` — 连接生命周期与对子 Agent 暴露（见 [equipResource](/zh/api/equip#equipresource)）。
2. `const kit = await equipMCP(client, { clientId, … })` — 拉取并转换工具定义；再 `kit.inject()` 才 `equipTool` 注册到当前 Agent。

**示例（stdio + 官方 SDK）：**

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

**纯转换（单工具）：** 导出函数 `fromMCPTool(mcpTool, client, { name? })` 可将单个 MCP Tool 转为 `ToolDefinition`，便于自行组合或测试。

**MCPKit：** `equipMCP` 返回 `client`、`tools`（仅 MCP 业务工具）、`resourceTools`（`list_resources` / `read_resource` 合成工具）、`toolMap`、`resourceToolMap`、`prompts`（`list` / `get` + **`asInstruction()`**，返回 `MessageContent`，可直接传给 `equipInstruction`）、`inject`。调用 **`inject({ injectTools?, injectResourceTools?, middleware? })`** 时才 `equipTool`：默认 **`injectTools: true`**、**`injectResourceTools: false`**（避免在 Prompt 里塞满资源 URI；需要时再打开）。**本次 `await equipMCP(...)` 返回的 `kit.tools` 即本轮拉取/缓存解析后的快照**，不会在之后静默变新；需要最新列表时应在**下一次**调用 `equipMCP` 时传入 **`forceRefresh: true`**（见下）。

**命名契约：** `options.tools` 中的名字**始终是 MCP 服务端返回的原始工具名**（用于过滤与 `callTool`）；**`namespace`** 只影响注册到 Agent / LLM 侧的名字（多 MCP 并存时避免 `read_file` 重名）。若声明了 `tools` 却无法在分页与 `maxItems` 内找齐，适配器会 **抛错**（Fail Fast），避免带着残缺工具集调用模型。

**强制刷新列表（声明式）：** `forceRefresh: true` 表示**本轮** `equipMCP` **跳过 tools/list 的 memo**，向 MCP 重新拉取并**写回** `equipMemo` 缓存（通过推进 list epoch）。适用于你确信服务端工具集已变，或你希望**每次** `equipMCP` 都重新 `listTools`（每次调用都传 `forceRefresh: true`）。

## EquipMCPOptions 接口

```typescript
interface EquipMCPOptions {
  clientId: string;
  /** 注册到 Agent 的工具名命名空间；`tools` 过滤仍用 MCP 原生名 */
  namespace?: string;
  tools?: string[];
  /** 本轮跳过 memo、重新 listTools 并覆盖缓存 */
  forceRefresh?: boolean;
  /** 是否跟随 listTools 的 nextCursor 拉全部分页，默认 true */
  autoPaginate?: boolean;
  /** 最多收集多少个 Tool（防御），默认 100 */
  maxItems?: number;
  /**
   * 为 true 时在 `resourceTools` 中生成合成的 list/read 资源工具（与 MCP 协议里的 ClientCapabilities 无关）。
   */
  enableResources?: boolean;
  middleware?: ToolMiddleware[];
}
```

**MCPClientAdapter（Facade）：** 与官方 `@modelcontextprotocol/sdk` 的 `Client` 类型不同；为 Rejelly 准备的简化契约。`inputSchema` 保留服务端 JSON Schema；`callTool` 的 `content` 支持 `text` / `image` / `audio` / `resource` 等块；`isError` 与协议一致。可选方法在运行时与 SDK 对齐（如 `getPrompt` 常为单对象参数）。

## 工作原理

1. **连接**：由你在 [equipResource](/zh/api/equip#equipresource) 的 `create` 中 `connect` 官方 Client；`destroy` 中 `close`。
2. **工具**：`listTools` 支持 `nextCursor` 时由 `autoPaginate` + `maxItems` 控制拉取；若配置了 `tools`（原生名列表）却未能在分页与上限内找齐，**直接抛错**；结果默认经 `equipMemo` 缓存（相同 `clientId` 与 deps 时 `reborn()` 不重复 RPC）；**`forceRefresh: true`** 时跳过命中并刷新缓存；为每个 MCP 工具生成 `ToolDefinition`（JSON Schema 原样进入 `jsonSchemaToZod`）；**`kit.inject({ injectTools: true })`** 时注册。
3. **调用**：`callTool` 兼容 SDK 的 `callTool({ name, arguments })` 与 `(name, args)`；纯文本结果按文本返回，含图片等非文本块时转成 `toolContent`（见 [Adapter · 多模态工具结果](/zh/api/adapter/#多模态工具结果-multimodal-tool-results)）。
4. **资源**：**`enableResources`** 为 true 时生成 **`resourceTools`**（`list_resources` 带 cursor、`read_resource` 按 URI），**不在 equip 时全量 list**；需 **`inject({ injectResourceTools: true })`** 才注册。
5. **Prompts**：`kit.prompts.list()` / `get()` 供你在业务里手动 `equipInstruction`；`get` 返回含 **`asInstruction()`**（`MessageContent`：`string | ContentPart[]`，含 text / image / video，与 `@rejelly/core` 中定义一致）。

## 与 equipResource 配合

- 典型做法：`await equipResource('mcp:<name>', { create, destroy, deps, expose: true })` 得到长生命周期 Client，再 `await equipMCP(client, { clientId, … })` 得到 `kit`，最后 `kit.inject()`。
- 子 Agent 若要在代码里直接使用同一连接，使用 [expectResource](/zh/api/expect#expectresource)：**`expectResource<MCPClientAdapter>('mcp:<name>')`**，key 必须与父级 `equipResource` 完全一致（含 `mcp:` 前缀）。

**注意事项：**

- 子 Agent 读取父级暴露的 Client 前，父 Agent 须已 `equipResource('mcp:…', { expose: true })` 且**先于**子 Agent 执行完成注册。
- 需要绕过 memo、每次重新 `listTools` 时传 **`forceRefresh: true`**（可每轮 `equipMCP` 都传）。
- 官方 SDK 的 `readResource` 多为 `readResource({ uri })`，与 `MCPClientAdapter` 文档签名可能不一致，需在业务侧适配或断言类型。

## 父子 Agent 示例（子级用 `expectResource`）

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
    equipInstruction(`工作目录：${workspace}\n配置文件：${JSON.stringify(configData)}`);
    return await promptAgent(ResultSchema);
  },
});
```
