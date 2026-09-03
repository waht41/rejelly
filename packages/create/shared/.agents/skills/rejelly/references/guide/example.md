# Example Index

Runnable examples are located in the [`examples/`](https://github.com/waht41/rejelly/tree/main/examples) directory, organized by difficulty: **01-basics**, **02-patterns**, **03-advanced**. Below is a summary with links to the corresponding code (GitHub: <https://github.com/waht41/rejelly>).

## 01 · Basics

| Description | Code Location |
|-------------|---------------|
| **Chat Agent**: Multi-turn conversational flow; uses `reborn` + `equipMemory` inside an Agent to manage conversation state, rebuilding the Prompt from current state each round. | [`examples/01-basics/chat-agent/`](https://github.com/waht41/rejelly/tree/main/examples/01-basics/chat-agent) · Entry [`index.ts`](https://github.com/waht41/rejelly/blob/main/examples/01-basics/chat-agent/index.ts) |
| **Multi-model Agent**: Multi-modal input (image/video); passes structured `ContentPart[]` via `equipInstruction`. | [`examples/01-basics/multi-model-agent/`](https://github.com/waht41/rejelly/tree/main/examples/01-basics/multi-model-agent) · Core [`multi-model-agent.ts`](https://github.com/waht41/rejelly/blob/main/examples/01-basics/multi-model-agent/multi-model-agent.ts) |
| **MCP Integration**: Connects to MCP Server via `@rejelly/adapter-mcp`, working with `equipResource` / `equipMCP`. | [`examples/01-basics/mcp-integration/`](https://github.com/waht41/rejelly/tree/main/examples/01-basics/mcp-integration) · Entry [`index.ts`](https://github.com/waht41/rejelly/blob/main/examples/01-basics/mcp-integration/index.ts) |

## 02 · Patterns

| Description | Code Location |
|-------------|---------------|
| **Router**: Intent recognition + Zod-structured routing decisions, dispatching to sub-agents via native `switch`. | [`examples/02-patterns/router-agent/`](https://github.com/waht41/rejelly/tree/main/examples/02-patterns/router-agent) · Logic [`router-agent.ts`](https://github.com/waht41/rejelly/blob/main/examples/02-patterns/router-agent/router-agent.ts) |
| **Coding Agent**: A minimal coding agent inside a sandbox workspace — explore → edit → run → verify. File/shell tools are native `ToolDefinition` objects. Logging and human approval are mounted per-tool as tool middleware (read-only passes, write requires gate). A single `promptChat` drives the full tool loop. | [`examples/02-patterns/coding-agent/`](https://github.com/waht41/rejelly/tree/main/examples/02-patterns/coding-agent) · Core [`coding-agent.ts`](https://github.com/waht41/rejelly/blob/main/examples/02-patterns/coding-agent/coding-agent.ts), tools [`tools.ts`](https://github.com/waht41/rejelly/blob/main/examples/02-patterns/coding-agent/tools.ts) |

## 03 · Advanced

| Description | Code Location |
|-------------|---------------|
| **Fan-in / Fan-out**: Parallel Worker Agents (`Promise.all`), then aggregated into a single Summarizer. | [`examples/03-advanced/fan-in-fan-out/`](https://github.com/waht41/rejelly/tree/main/examples/03-advanced/fan-in-fan-out) · Entry [`index.ts`](https://github.com/waht41/rejelly/blob/main/examples/03-advanced/fan-in-fan-out/index.ts) |
| **Time-travel**: `dumpSnapshot` / `restoreSnapshot` with trace replay (reproduction path without extra LLM calls). | [`examples/03-advanced/time-travel/`](https://github.com/waht41/rejelly/tree/main/examples/03-advanced/time-travel) · [`dump-example.ts`](https://github.com/waht41/rejelly/blob/main/examples/03-advanced/time-travel/dump-example.ts), [`restore-example.ts`](https://github.com/waht41/rejelly/blob/main/examples/03-advanced/time-travel/restore-example.ts) |
| **Graph Policy**: A LangGraph-style writer–critic graph (typed state, conditional edges, cycles, critic concurrent fan-out) implemented as a custom prompt policy. Built on `createAgentPolicy` + `executeTurn` + `executeValidation` — core has zero knowledge of graphs. Uses `usedTurnSteps` for graceful degradation under budget constraints. | [`examples/03-advanced/graph-policy/`](https://github.com/waht41/rejelly/tree/main/examples/03-advanced/graph-policy) · Runtime [`graph-policy.ts`](https://github.com/waht41/rejelly/blob/main/examples/03-advanced/graph-policy/graph-policy.ts), specific graph [`writer-critic-agent.ts`](https://github.com/waht41/rejelly/blob/main/examples/03-advanced/graph-policy/writer-critic-agent.ts) |

## Shared & Running

| Description | Code Location |
|-------------|---------------|
| **Shared models and pricing**: OpenAI adapter, `calculateCost` and `model-pricing` table shared across examples. | [`examples/shared/`](https://github.com/waht41/rejelly/tree/main/examples/shared) · e.g. [`openai-model.ts`](https://github.com/waht41/rejelly/blob/main/examples/shared/openai-model.ts), [`model-pricing.ts`](https://github.com/waht41/rejelly/blob/main/examples/shared/model-pricing.ts) |
| **Unified start script**: Select examples by module name (matches `pnpm run start` in the README). | [`examples/scripts/run.ts`](https://github.com/waht41/rejelly/blob/main/examples/scripts/run.ts) |

Each subdirectory's `README.md` (some also include `README.zh-CN.md`) has run commands and detailed explanations. Install dependencies at the **`examples/`** root, then follow the corresponding README.
