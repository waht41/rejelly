English | [简体中文](./README.zh-CN.md)

<div align="center">

# Rejelly

**Write Agents like React — Agents are functions, Prompts are built with Hooks.**

[![npm](https://img.shields.io/npm/v/%40rejelly%2Fcore?label=%40rejelly%2Fcore)](https://www.npmjs.com/package/@rejelly/core)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](#development)

</div>

Rejelly is a React-inspired Agent framework: treat an Agent as a **function that receives props**, build its Prompt in place with **Hooks**, and constrain model output with a **Zod contract**. Built for LLM applications.

## Why Rejelly

- **Agent as a function** — `createAgent` wraps an async function: input goes in, result comes out, called like any ordinary function.
- **Build Prompts with Hooks** — the `equip` family (system / instruction / tool / memory) aggregates related logic in place, eliminating scattered string concatenation and explicit `ctx` passing (backed by AsyncLocalStorage).
- **Contract-driven output** — `promptAgent` with a Zod Schema defines and validates the model's output structure; on a mismatch the framework retries automatically with error feedback.
- **`reborn` rebuilds context** — each round re-renders the Prompt from the latest Memory instead of appending history across rounds, always describing the current state and intent.

## Quick Start

```bash
# Fastest path: scaffold (interactive — prompts for project name / template / model adapter)
npm create rejelly@latest

# Or install the core + one model adapter manually
npm install @rejelly/core @rejelly/adapter-openai zod
```

After scaffolding, follow the prompts to enter your project: `cd <project> && pnpm install`, edit `.env` to set your API keys, then `pnpm start`.

A working single-round Agent looks like this:

```ts
import { createAgent, equipSystem, equipInstruction, promptAgent } from '@rejelly/core';
import { z } from 'zod';

// openaiModel is a model adapter — see the adapter docs for construction
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

Full step-by-step tutorial (adding tools, multi-round, reborn) in the docs:

📖 **[Documentation](./docs/en/guide/index.md)** · [API Reference](./docs/en/api/index.md) · [中文文档](./docs/zh/guide/index.md)

## Debugging & Observability (DevTool)

**DevTool** is Rejelly's local debugging tool: receive, store, and inspect Agent runtime **Traces**, with a built-in local Server, visual UI, HTTP API, MCP tools, and optional AI-assisted analysis. Install it as a dev dependency in the project you want to debug:

```bash
pnpm add -D @rejelly/devtool
```

Together with `@rejelly/core`'s **Time Travel** (snapshot / event replay: `dumpSnapshot` · `restoreSnapshot` · `runWith`, from `@rejelly/core/debugger`), you can reproduce and step through a run locally — collect Traces in production and rebuild the snapshot for debugging afterward. See **[DevTool guide](./docs/en/guide/devtool.md)** and **[Time Travel](./docs/en/api/time-travel.md)**.

## What's in the Repo

This is a pnpm + turbo monorepo. User-facing packages:

| Package | Description |
|------|------|
| [`@rejelly/core`](./packages/core) | Core framework: `createAgent` / the `equip` family / `promptAgent` / `reborn`. |
| [`@rejelly/adapter-openai`](./packages/adapters) · `-gemini` · `-langchain` · `-mcp` | Model & tool adapters. |
| [`@rejelly/limit-model`](./packages/limit-model) | Rate-limiting middleware for model adapters (TPM / RPM / concurrency; in-memory or Redis). |
| [`create-rejelly`](./packages/create) | `npm create rejelly` scaffolder — spin up a Rejelly app in seconds. |
| [`@rejelly/devtool`](./apps/devtool-server) | Local debugging tool: collect / store / inspect runtime Traces; built-in Server + UI + HTTP API + MCP. |

Examples (each ships a bilingual README): **[`examples/`](./examples)** — `01-basics` · `02-patterns` · `03-advanced`.

Reference app (self-hosting / dogfooding): **[`apps/evil-jelly`](./apps/evil-jelly)** (published as `@rejelly/evil-jelly`) — a terminal coding-Agent CLI built with Rejelly: conversational code edits (diff-confirmed before writing), command execution, ad-hoc web search, plus read-only code / documentation audits (`evil audit`). It's both a **reference implementation** of the framework at real application scale and this repo's **self-iteration tool** — iterating the framework with the framework. Want to see what Rejelly builds? Start here.

> The remaining packages are internal, not user APIs: `jelly-lint` (architecture-boundary governance), `devtool-ui` / `devtool-contracts` (DevTool's built-in UI and shared contracts), `env`, `ink` (fork), `test-utils`, `release-tools`, etc.

## Development

Prerequisites: **Node ≥ 18**, **pnpm 10** (pinned to `pnpm@10.28.2`). `jelly-lint` is a Rust CLI — `pnpm build` / `pnpm lint:jelly` build it with `cargo`, so install the **Rust toolchain (cargo)** first (see [rustup.rs](https://rustup.rs)).

```bash
pnpm install         # install all workspace deps
pnpm build           # build every package via turbo
pnpm typecheck       # full type check
pnpm test            # run tests
pnpm lint:jelly      # jelly-lint (Rust CLI, needs cargo) checks architecture import boundaries
pnpm check           # typecheck + lint + biome in one shot
```

Architecture dependency direction is declaratively enforced by `jelly-lint` (config at repo root `jellylint.json[c]`): imports may only point downward. Run `pnpm lint:jelly` before changing anything that crosses package boundaries.

## License

[Apache-2.0](./LICENSE)
