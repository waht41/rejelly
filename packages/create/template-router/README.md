# Rejelly Router App

A [Rejelly](https://github.com/waht41/rejelly) template that demonstrates the **Router Pattern**: one main Agent understands user intent via the LLM, then deterministic code routes to specialist sub-agents (chat, CLI, life, or fallback).

## Quick start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment variables

Open `.env` and set `OPENAI_API_KEY` or `GEMINI_API_KEY` (or keep the built-in mock model for a quick try).

### 3. Run the app

```bash
pnpm start
```

Enter a request at the prompt; the router will classify it and forward to the right specialist. Run tests with `pnpm test`.

---

## Project structure

- **`src/index.ts`** — Entry point. Creates the model adapter, reads user input from stdin, and runs `createRouterAgent(model)`.
- **`src/router-agent.ts`** — Router + sub-agents:
  - **RouterAgent** uses `equipSystem` / `equipInstruction` and `promptAgent(IntentSchema)` so the LLM returns `{ reason, target }`. The framework validates output against the schema.
  - A `switch (decision.target)` routes to **ChatAgent**, **CLIAgent**, **LifeAgent**, or an `other` fallback. Sub-agents are plain async functions; replace their handlers with real logic or more agents.
  - The model is passed into `createRouterAgent(model)`, so tests can use a mock model without requiring API keys.
- **`src/router-agent.test.ts`** — Tests each route (chat / cli / life / other) using `createMockModel` and `createRouterAgent(mock.adapter)`.

## Learn more

- [Agent-as-function and core API](https://docs.rejelly.dev/en/api/core)
- [Full docs](https://docs.rejelly.dev/en/)
- `AGENTS.md` — concise Rejelly guidance for AI coding assistants.
- `.agents/skills/rejelly` — portable Rejelly Skill with a bundled documentation snapshot for progressive offline reference.
