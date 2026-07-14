# DevTool

DevTool is Rejelly's local debugging tool for receiving, storing, and inspecting Agent runtime Traces. It includes a local Server, built-in UI, HTTP API, MCP tools, and optional AI-assisted analysis.

## Installation

Install in the project where you want to debug your Rejelly application:

```bash
pnpm add -D @rejelly/devtool
```

Or use other package managers:

```bash
npm install -D @rejelly/devtool
yarn add -D @rejelly/devtool
```

### pnpm 10 and better-sqlite3

DevTool uses SQLite to store Traces, depending on a native package like `better-sqlite3`. pnpm 10 may intercept its build script by default. If you encounter `better-sqlite3` errors after installation, first allow it to build:

```bash
pnpm approve-builds
```

Select `better-sqlite3` in the interactive list. To persist the approval in your project config, add this to `package.json`:

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["better-sqlite3"]
  }
}
```

Then reinstall or rebuild:

```bash
pnpm install
pnpm rebuild better-sqlite3
```

## Quick Start

Start DevTool:

```bash
pnpm exec rejelly-devtool
```

Default addresses:

| Address | Purpose |
|---------|---------|
| `http://127.0.0.1:5789` | DevTool UI |
| `http://127.0.0.1:5789/docs` | HTTP API docs |
| `http://127.0.0.1:5789/api/v1/traces` | Trace reporting endpoint |
| `http://127.0.0.1:5789/mcp` | MCP endpoint |

By default, DevTool listens only on `127.0.0.1`, and Trace data is saved to `./.rejelly/devtool.sqlite3` in the current working directory.

## Connecting Your Rejelly Application

Once DevTool is running, you need to configure your Rejelly app to send Traces to it. The easiest way is to enable the Review exporter during app startup:

```typescript
import { enableReview } from "@rejelly/core/debugger";

const disableReview = enableReview({
  endpoint: "http://127.0.0.1:5789/api/v1/traces",
});
```

If using the default address, you can also configure it via environment variable:

```bash
REJELLY_REVIEW_ENDPOINT=http://127.0.0.1:5789/api/v1/traces
```

`enableReview()` batches and uploads Trace events during execution. To flush any cached events before the program exits, call the returned close function:

```typescript
await disableReview();
```

For more Review exporter options, see the [Debugger API](/en/api/debug#review-exporter).

## Common Commands and Options

`rejelly-devtool` starts the local Server without any subcommand:

```bash
pnpm exec rejelly-devtool
```

Common options:

| Option | Purpose |
|--------|---------|
| `-p, --port <port>` | Change the listen port, default `5789` |
| `--host <addr>` | Change the listen address, default `127.0.0.1` |
| `--db <path>` | Specify Trace SQLite DB path, default `./.rejelly/devtool.sqlite3` |
| `--review` | Record Traces produced by DevTool's own AI Agent |

Examples:

```bash
pnpm exec rejelly-devtool --port 5790
pnpm exec rejelly-devtool --db ./.rejelly/local-devtool.sqlite3
pnpm exec rejelly-devtool --host 0.0.0.0
```

Corresponding environment variables:

| Environment Variable | Purpose |
|---------------------|---------|
| `REJELLY_DEVTOOL_PORT` | Default port |
| `REJELLY_DEVTOOL_HOST` | Default listen address |
| `REJELLY_DEVTOOL_DB_PATH` | Default DB path |
| `REJELLY_REVIEW_ENDPOINT` | Default reporting endpoint for Rejelly apps |

If you set `--host` to `0.0.0.0`, other devices on the local network may access DevTool. Traces typically contain prompts, model outputs, tool call parameters, error information, and other debugging data — only expose in trusted networks.

## Using the UI

Open `http://127.0.0.1:5789` to enter the DevTool UI. Common views include:

- **Trace History**: View recently reported or imported Traces.
- **Waterfall**: View Agent, model calls, tool calls, and custom spans along a timeline.
- **Detail**: View input, output, messages, tool calls, errors, and token usage for a selected node.
- **Filter / Search**: Filter Traces by status, name, time, type, model usage, cost fields, or tool execution information.
- **Ask AI**: Perform auxiliary analysis on the current Trace after configuring AI parameters.

If the UI shows no Traces, first verify that your application has called `enableReview()` and that the `endpoint` points to the current DevTool's `/api/v1/traces`.

## API Docs

Once the DevTool Server is running, open in your browser:

```text
http://127.0.0.1:5789/docs
```

This provides the HTTP API documentation for the current Server, covering Trace listing, search, details, event reading, import/reporting, metadata updates, AI analysis, and more.

## Importing and Exporting Traces

DevTool supports importing Traces from local files and exporting current Traces to files, making it easy to reproduce and share debugging sessions.

### Importing Traces

In the UI, select or drag and drop a Trace file. Supported formats:

- `.jsonl` / `.ndjson`: One `TraceEvent` JSON object per line; a single line may also contain an array of events.
- `.json`: A `TraceEvent[]` array, or a `{ "events": [...] }` structure.

On import, DevTool uploads raw events to the local Server and writes them to the current DB. If the file contains multiple `traceId` values, they are grouped and imported by `traceId`.

### Exporting Traces

In the UI, export the current Trace — it reads the Trace's raw events from the Server and downloads them as:

```text
trace-<traceId>.jsonl
```

Exported files can be re-imported into DevTool. Note that import/export uses raw `TraceEvent` objects, not the normalized trace objects used internally by the UI.

## MCP Tools

DevTool also exposes a Streamable HTTP MCP endpoint:

```text
http://127.0.0.1:5789/mcp
```

Once an MCP client connects, you can use DevTool's Trace introspection tools to query Traces in the current DB. Common tools include:

| Tool | Purpose |
|------|---------|
| `search_traces` | Search the Trace list |
| `get_trace_profile` | Get Trace overview |
| `inspect_node` | View details of a specific node |
| `list_message` | List messages |
| `search_trace_messages` | Search message content |
| `list_agent_tool` | View available Agent tools |
| `search_trace_events` | Search raw events |
| `list_tool_calls` | List tool calls |

Most tools accept a `traceId` parameter; if omitted, they typically use the latest Trace in the DB. Tool parameters are JSON objects, following each tool's own schema.

You can also run the same tools directly from the command line:

```bash
pnpm exec rejelly-devtool tools --list
pnpm exec rejelly-devtool tools --describe list_message
pnpm exec rejelly-devtool tools get_trace_profile --json
pnpm exec rejelly-devtool tools inspect_node --args '{"nodeRef":"n1"}'
pnpm exec rejelly-devtool tools list_message --trace-id <trace_id>
```

To query a different DB:

```bash
pnpm exec rejelly-devtool tools --db ./.rejelly/devtool.sqlite3 --list
```

## AI Agent Features

DevTool's AI features are optional, used for generating Trace filter conditions, analyzing the current Trace, and assisting in anomaly identification. Before enabling, configure OpenAI-compatible model parameters for the DevTool Server:

```bash
OPENAI_API_KEY=<your-api-key>
OPENAI_MODEL_ID=gpt-5.6-luna
OPENAI_BASE_URL=https://api.openai.com/v1
```

Only `OPENAI_API_KEY` is required; `OPENAI_MODEL_ID` defaults to `gpt-5.6-luna`, and `OPENAI_BASE_URL` can be set when using a compatible gateway or private model service.

After configuration, restart DevTool:

```bash
pnpm exec rejelly-devtool
```

If `OPENAI_API_KEY` is not set, AI-related interfaces will return `AI_NOT_CONFIGURED`, and the AI features in the UI will not function.

To observe the Traces produced by DevTool's own AI Agent, start with `--review`:

```bash
pnpm exec rejelly-devtool --review
```

This writes DevTool's own AI analysis traces back to the current DevTool DB, useful for debugging the AI features themselves.

## Frequently Asked Questions

### better-sqlite3 error on startup

This is typically caused by pnpm 10 blocking the native dependency's build script. Run:

```bash
pnpm approve-builds
pnpm rebuild better-sqlite3
```

And confirm that `better-sqlite3` is allowed to build.

### Port already in use

Start on a different port:

```bash
pnpm exec rejelly-devtool --port 5790
```

Then update the reporting endpoint in your application:

```text
http://127.0.0.1:5790/api/v1/traces
```

### No Traces in the UI

Check three things first:

1. Has your Rejelly application called `enableReview()`?
2. Is the `endpoint` pointing to the current DevTool's `/api/v1/traces`?
3. Has your application actually executed an Agent and produced Trace events?

### AI features not available

Ensure the DevTool process can read:

```bash
OPENAI_API_KEY
```

When using an OpenAI-compatible gateway, also verify that `OPENAI_BASE_URL` and `OPENAI_MODEL_ID` are correct.

### Wrong Trace data found

Confirm the DB path used by the current Server. The default path is relative to the current working directory of the startup command:

```text
./.rejelly/devtool.sqlite3
```

You can specify it explicitly:

```bash
pnpm exec rejelly-devtool --db /path/to/devtool.sqlite3
```
