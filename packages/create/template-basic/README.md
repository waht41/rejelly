# My Rejelly App

Welcome to your first Agent app built with [Rejelly](https://github.com/waht41/rejelly)!

This is an interactive Chat template generated from the Rejelly framework. It shows how to use core hooks (e.g. `equipMemory`, `equipSystem`) and the goal-oriented `reborn` mechanism to build a multi-turn conversation Agent.

## Quick start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment variables


Open `.env` and set `OPENAI_API_KEY` or `GEMINI_API_KEY`.

### 3. Run the app

```bash
pnpm start
```

---

## Project structure

The template includes these main files. Reading them in order is a good way to understand how Rejelly works:

- **`src/index.ts`** — Entry point. Loads env, creates the model adapter, sets up terminal I/O, and runs `createChatAgent(model)`.
- **`src/chat-agent.ts`** — Exports `createChatAgent(model)` so tests can pass a mock model without requiring API keys. Agent logic:
  - `createAgent` to define the agent
  - `equipMemory` for cross-turn conversation history
  - `reborn` instead of a `while (true)` loop for state flow and multi-turn chat
- **`src/chat-agent.test.ts`** — Unit tests using Rejelly’s `createMockModel` for deterministic, offline tests.

## Learn more

- [Agent-as-function and core API](https://docs.rejelly.dev/en/api/core)
- [Full docs](https://docs.rejelly.dev/en/)
- `AGENTS.md` — Rejelly guidance for AI coding assistants (Claude Code, Cursor, etc.); they pick it up automatically when working in this project.
