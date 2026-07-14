# DevTool

DevTool 是 Rejelly 的本地调试工具，用于接收、保存和查看 Agent 运行时产生的 Trace。它包含一个本地 Server、内置 UI、HTTP API、MCP 工具，以及可选的 AI 辅助分析能力。

## 安装

在需要调试 Rejelly 应用的项目中安装：

```bash
pnpm add -D @rejelly/devtool
```

也可以使用其他包管理器：

```bash
npm install -D @rejelly/devtool
yarn add -D @rejelly/devtool
```

### pnpm 10 与 better-sqlite3

DevTool 使用 SQLite 保存 Trace，依赖 `better-sqlite3` 这样的 native package。pnpm 10 默认可能拦截依赖的 build script；如果安装后启动时报 `better-sqlite3` 相关错误，先允许它执行构建：

```bash
pnpm approve-builds
```

在交互列表中选择 `better-sqlite3`。如果希望把允许规则写入项目配置，可以在 `package.json` 中加入：

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["better-sqlite3"]
  }
}
```

之后重新安装或重建依赖：

```bash
pnpm install
pnpm rebuild better-sqlite3
```

## 快速开始

启动 DevTool：

```bash
pnpm exec rejelly-devtool
```

默认地址：

| 地址 | 作用 |
| --- | --- |
| `http://127.0.0.1:5789` | DevTool UI |
| `http://127.0.0.1:5789/docs` | HTTP API 文档 |
| `http://127.0.0.1:5789/api/v1/traces` | Trace 上报接口 |
| `http://127.0.0.1:5789/mcp` | MCP endpoint |

默认情况下，DevTool 只监听本机地址 `127.0.0.1`，Trace 数据会保存到当前工作目录下的 `./.rejelly/devtool.sqlite3`。

## 接入 Rejelly 应用

DevTool 启动后，还需要让你的 Rejelly 应用把 Trace 发送到 DevTool。最直接的方式是在应用启动阶段启用 Review exporter：

```typescript
import { enableReview } from "@rejelly/core/debugger";

const disableReview = enableReview({
  endpoint: "http://127.0.0.1:5789/api/v1/traces",
});
```

如果使用默认地址，也可以只通过环境变量配置：

```bash
REJELLY_REVIEW_ENDPOINT=http://127.0.0.1:5789/api/v1/traces
```

`enableReview()` 会批量上报运行中的 Trace 事件。程序退出前如需确保缓存事件已发送，可以调用返回的关闭函数：

```typescript
await disableReview();
```

更多 Review exporter 参数见 [Debugger API](/zh/api/debug#review-exporter)。

## 常用命令和参数

`rejelly-devtool` 不带子命令时会启动本地 Server：

```bash
pnpm exec rejelly-devtool
```

常用参数：

| 参数 | 作用 |
| --- | --- |
| `-p, --port <port>` | 修改监听端口，默认 `5789` |
| `--host <addr>` | 修改监听地址，默认 `127.0.0.1` |
| `--db <path>` | 指定 Trace SQLite DB 路径，默认 `./.rejelly/devtool.sqlite3` |
| `--review` | 记录 DevTool 自身 AI Agent 产生的 Trace |

示例：

```bash
pnpm exec rejelly-devtool --port 5790
pnpm exec rejelly-devtool --db ./.rejelly/local-devtool.sqlite3
pnpm exec rejelly-devtool --host 0.0.0.0
```

对应的环境变量：

| 环境变量 | 作用 |
| --- | --- |
| `REJELLY_DEVTOOL_PORT` | 默认端口 |
| `REJELLY_DEVTOOL_HOST` | 默认监听地址 |
| `REJELLY_DEVTOOL_DB_PATH` | 默认 DB 路径 |
| `REJELLY_REVIEW_ENDPOINT` | Rejelly 应用默认上报地址 |

如果把 `--host` 设置为 `0.0.0.0`，局域网内其他设备可能访问到 DevTool。Trace 里通常包含 prompt、模型输出、工具调用参数、错误信息等调试数据，请只在可信网络中暴露。

## 使用 UI

打开 `http://127.0.0.1:5789` 可以进入 DevTool UI。常用视图包括：

- Trace 历史：查看最近上报或导入的 Trace。
- Waterfall：按时间线查看 Agent、模型调用、工具调用和自定义 span。
- Detail：查看选中节点的输入、输出、消息、工具调用、错误和 token 用量。
- Filter / Search：按状态、名称、时间、类型、模型用量、成本字段或工具执行信息筛选 Trace。
- Ask AI：在配置 AI 参数后，对当前 Trace 做辅助分析。

如果 UI 中没有 Trace，先确认应用是否已经调用 `enableReview()`，以及 endpoint 是否指向当前 DevTool 的 `/api/v1/traces`。

## API 文档

DevTool Server 启动后，可以在浏览器打开：

```text
http://127.0.0.1:5789/docs
```

这里提供当前 Server 暴露的 HTTP API 文档，适合查看 Trace 列表、搜索、详情、事件读取、导入上报、元数据更新、AI 分析等接口的请求和响应结构。

## 导入和导出 Trace

DevTool 支持从本地文件导入 Trace，也支持把当前 Trace 导出为文件，方便复现和分享调试现场。

### 导入 Trace

在 UI 中选择或拖入 Trace 文件。支持的格式：

- `.jsonl` / `.ndjson`：每行一个 `TraceEvent` JSON 对象，也允许单行是事件数组。
- `.json`：`TraceEvent[]` 数组，或 `{ "events": [...] }` 结构。

导入时，DevTool 会把 raw events 上传到本地 Server，并写入当前 DB。文件中如果包含多个 `traceId`，会按 `traceId` 分组导入。

### 导出 Trace

在 UI 中对当前 Trace 执行导出，会从 Server 读取该 Trace 的 raw events，并下载为：

```text
trace-<traceId>.jsonl
```

导出的文件可以再次导入 DevTool。注意这里导入和导出的是原始 `TraceEvent`，不是 UI 内部处理后的 normalized trace 对象。

## MCP 工具

DevTool 同时暴露 Streamable HTTP MCP endpoint：

```text
http://127.0.0.1:5789/mcp
```

MCP 客户端连接后，可以使用 DevTool 的 Trace introspection 工具读取当前 DB 中的 Trace。常用工具包括：

| 工具 | 作用 |
| --- | --- |
| `search_traces` | 搜索 Trace 列表 |
| `get_trace_profile` | 获取 Trace 概览 |
| `inspect_node` | 查看指定节点详情 |
| `list_message` | 列出消息 |
| `search_trace_messages` | 搜索消息内容 |
| `list_agent_tool` | 查看 Agent 可用工具 |
| `search_trace_events` | 搜索原始事件 |
| `list_tool_calls` | 列出工具调用 |

多数工具可以传入 `traceId`；未传时通常会使用 DB 中最新的 Trace。工具参数使用 JSON object，并遵循各工具自己的 schema。

也可以直接在命令行运行同一组工具：

```bash
pnpm exec rejelly-devtool tools --list
pnpm exec rejelly-devtool tools --describe list_message
pnpm exec rejelly-devtool tools get_trace_profile --json
pnpm exec rejelly-devtool tools inspect_node --args '{"nodeRef":"n1"}'
pnpm exec rejelly-devtool tools list_message --trace-id <trace_id>
```

如果要查询另一个 DB：

```bash
pnpm exec rejelly-devtool tools --db ./.rejelly/devtool.sqlite3 --list
```

## AI Agent 功能

DevTool 的 AI 功能是可选能力，用于生成 Trace 过滤条件、分析当前 Trace、辅助定位异常。启用前需要为 DevTool Server 配置 OpenAI 兼容模型参数：

```bash
OPENAI_API_KEY=<your-api-key>
OPENAI_MODEL_ID=gpt-5.6-luna
OPENAI_BASE_URL=https://api.openai.com/v1
```

其中只有 `OPENAI_API_KEY` 是必填；`OPENAI_MODEL_ID` 默认是 `gpt-5.6-luna`，`OPENAI_BASE_URL` 可在使用兼容网关或私有模型服务时设置。

配置后重新启动 DevTool：

```bash
pnpm exec rejelly-devtool
```

如果没有配置 `OPENAI_API_KEY`，AI 相关接口会返回 `AI_NOT_CONFIGURED`，UI 中的 AI 功能也无法正常使用。

如需观察 DevTool 自身 AI Agent 的运行 Trace，可以启动时加上 `--review`：

```bash
pnpm exec rejelly-devtool --review
```

这会把 DevTool 自己的 AI 分析过程也写回当前 DevTool DB，适合调试 AI 功能本身。

## 常见问题

### 启动时报 better-sqlite3 错误

通常是 pnpm 10 拦截了 native dependency 的 build script。执行：

```bash
pnpm approve-builds
pnpm rebuild better-sqlite3
```

并确认 `better-sqlite3` 已被允许构建。

### 端口被占用

换一个端口启动：

```bash
pnpm exec rejelly-devtool --port 5790
```

同时把应用侧的上报地址改成：

```text
http://127.0.0.1:5790/api/v1/traces
```

### UI 没有任何 Trace

优先检查三件事：

1. Rejelly 应用是否调用了 `enableReview()`。
2. `endpoint` 是否指向当前 DevTool 的 `/api/v1/traces`。
3. 应用是否真的执行了 Agent，并产生了 Trace 事件。

### AI 功能不可用

确认启动 DevTool 的进程能读取到：

```bash
OPENAI_API_KEY
```

使用 OpenAI 兼容网关时，再确认 `OPENAI_BASE_URL` 和 `OPENAI_MODEL_ID` 是否正确。

### 查到的 Trace 不是预期数据

确认当前 Server 使用的 DB 路径。默认路径跟启动命令的当前工作目录有关：

```text
./.rejelly/devtool.sqlite3
```

可以显式指定：

```bash
pnpm exec rejelly-devtool --db /path/to/devtool.sqlite3
```
