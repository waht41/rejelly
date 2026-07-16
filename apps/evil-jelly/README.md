# Evil Jelly

> A terminal coding-agent CLI built on `@rejelly/core`—and this repository's self-hosting dogfood host.



Evil Jelly is an early prerelease included in the repository-wide prerelease workflow; it can also be built from source or linked locally.

## Quick start

Requires Node.js **18 or later** and pnpm.

```bash
# From the monorepo root: build and link the global `evil` command
pnpm install
pnpm --filter @rejelly/evil-jelly build
cd apps/evil-jelly && pnpm link --global

# Configure the API key, then start an interactive session
evil init
evil

# Or run a one-shot read-only audit from any workspace root
evil audit --family clone
```

`evil init` writes user-level LLM settings. If your package registry publishes `@rejelly/evil-jelly`, you may install that package globally instead of linking the repository build. Source changes to a linked installation require another build. If pnpm reports a missing global bin directory, run `pnpm setup` once.

## What can it do?

### Interactive coding assistant

Run `evil` to chat, inspect and search code, edit files with diff confirmation, execute commands, and verify changes in one unified session.

### One-shot audits

Run `evil audit --family <name>` to analyze a workspace without modifying it. Reports and their ledger are written to `.evil-jelly/audit/`.

| Family | What it checks |
|--------|----------------|
| `clone` | Token-level code-duplication candidates. |
| `complexity` | Functions whose complexity may warrant decomposition. |
| `fragmentation` | Single-consumer micro-clusters that may be over-decomposed. |
| `doc-drift` | Factual drift between documentation and mapped code or artifacts. |
| `doc-sync` | Missing or inconsistent content across paired bilingual documents. |

## Common commands

```bash
evil                                      # Interactive coding session
evil audit --family clone                 # Read-only clone audit
evil audit --family complexity            # Read-only complexity audit
evil audit --family fragmentation         # Read-only fragmentation audit
evil audit --family doc-drift              # Validate docs against code
evil audit --family doc-sync               # Compare bilingual docs
evil audit --family fragmentation --only-actionable
evil --review audit --family doc-drift     # Export a Review trace
```

For repository development without a global link:

```bash
pnpm --filter @rejelly/evil-jelly start
pnpm --filter @rejelly/evil-jelly start -- audit --family clone --workspace ../..
```

## Configuration

`OPENAI_API_KEY` is the only required setting. The recommended setup is `evil init`; you can also provide it through the shell or `.evil-jelly/.env`. Defaults use the OpenAI-compatible endpoint and `gpt-5.6-luna`.

Configuration is resolved in this order: **CLI arguments > shell environment > workspace `.evil-jelly/.env` > `~/.evil-jelly/.env`**. Repository-safe settings live in `.evil-jelly/settings.jsonc`; documentation mappings live in `.evil-jelly/doc-map.jsonc`; secrets belong in `.evil-jelly/.env`.

<details>
<summary><strong>Complete environment variables</strong></summary>

### Loading and scope

A regular `.env` at the workspace root is not loaded: it belongs to the application being developed, not to Evil Jelly. When `OPENAI_BASE_URL` or `OPENAI_PROVIDER` comes from a workspace file but `OPENAI_API_KEY` comes from the shell or global file, startup warns that the repository is redirecting a key it does not own. Keep the key and endpoint in the same layer.

When `evil init` finds an existing key, press Enter to retain it. In a TTY it also asks for an optional Base URL and model. For non-interactive setup:

```bash
evil init --base-url https://api.deepseek.com --model deepseek-v4-flash
```

All variables except `OPENAI_API_KEY` are optional. Application-level LLM variables are registered in `ENV_VARS` in `src/shared/config.ts`.

#### LLM API

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | **Required**. OpenAI-compatible API key. |
| `OPENAI_MODEL_ID` | Defaults to `gpt-5.6-luna`. |
| `OPENAI_BASE_URL` | Defaults to `https://api.openai.com/v1`. |
| `OPENAI_PROVIDER` | Defaults to `openai`; DeepSeek-shaped configurations automatically use JSON mode. |
| `OPENAI_RETRY_MAX_ATTEMPTS` | Maximum model-call attempts (positive integer). Defaults to `3`. |
| `OPENAI_CONTEXT_WINDOW` | Actual model context window in tokens (positive integer). `/status` shows the remainder, and compaction uses this as its trimming limit; otherwise `200000` is used. |
| `OPENAI_AUTO_COMPACT_TOKENS` | Compaction threshold in tokens (positive integer); takes precedence over `OPENAI_AUTO_COMPACT_RATIO` and can force early compaction in tests. |
| `OPENAI_AUTO_COMPACT_RATIO` | Compaction threshold as an exclusive fraction between 0 and 1. Defaults to `0.75`. |
| `REJELLY_REVIEW_ENDPOINT` | Review reporting endpoint. Defaults to `http://localhost:5789/api/v1/traces`. |
| `REJELLY_ENABLE_REVIEW` | Setting this to `true` is equivalent to `--review`. |

#### LLM API proxy

| Variable | Description |
|----------|-------------|
| `USE_PROXY` | Set to `true` or `1` to enable a global HTTP proxy for LLM API calls. |
| `PROXY_URL` | Used when `USE_PROXY` is enabled and neither `HTTPS_PROXY` nor `HTTP_PROXY` is set. Defaults to `http://127.0.0.1:7890`. |

#### Web search

Web egress proxying is independent from LLM API proxying and defaults to a direct connection because Bing can return degraded results for proxy exit IPs. Parsing is implemented in `src/services/web/webConfig.ts`.

| Variable | Description |
|----------|-------------|
| `WEB_PROXY_URL` | Proxy used only for web fetching; the LLM proxy is not reused by default. |
| `WEB_USE_PROXY` | Set to `true` to reuse `PROXY_URL` for web fetching. |
| `WEB_USER_AGENT` | Fetch user agent. Defaults to the Chrome desktop user agent. |
| `WEB_TIMEOUT_MS` | Per-request timeout in milliseconds (positive integer). Defaults to `15000`. |
| `WEB_MAX_FETCH_BYTES` | Maximum bytes fetched per document (positive integer). Defaults to `2000000`. |
| `WEB_SEARCH_PROVIDER` | `bing` (SERP scraping, default) or `llm` (Anthropic-mirror `web_search`). |
| `WEB_SEARCH_BASE_URL` | SERP URL. Defaults to `https://www.bing.com/search`. |
| `WEB_SEARCH_MARKET` | Bing market hint such as `zh-CN`; blank by default for geo-detection. |
| `WEB_SEARCH_LLM_BASE_URL` | Anthropic-mirror root for the `llm` backend; defaults to `origin(OPENAI_BASE_URL) + /anthropic`. |
| `WEB_SEARCH_LLM_API_KEY` | `llm` backend key; falls back to `OPENAI_API_KEY`. |
| `WEB_SEARCH_LLM_MODEL` | `llm` backend model; falls back to `OPENAI_MODEL_ID`. |

Evil Jelly also follows OS shell conventions: `EDITOR` / `VISUAL` select the prompt editor (Windows `notepad`, POSIX `vi` by default), while `ComSpec` / `SHELL` select the command shell (`cmd.exe` / `/bin/sh` by default).

</details>

<details>
<summary><strong>All CLI options</strong></summary>

### Running from source

From the monorepo root:

```bash
pnpm --filter @rejelly/evil-jelly start
```

From `apps/evil-jelly`:

```bash
pnpm start          # Normal run
pnpm dev            # Start with --review --devtool
pnpm typecheck      # TypeScript checking
```

`pnpm --filter` changes the process cwd to `apps/evil-jelly`. For a workflow targeting the repository root, pass `--workspace ../..`. The global `evil` command uses the directory from which it is invoked and does not have this issue.

### Options and subcommands

- `--api-key <key>`: override `OPENAI_API_KEY` for this invocation. Prefer `evil init` for persistent setup and avoid exposing keys in shell history.
- `--review`: enable Review trace export, optionally with `REJELLY_REVIEW_ENDPOINT`.
- `--devtool`: connect to the devtool MCP tools. A failed connection prints a warning and execution continues.
- `--doc-map <path>`: workspace-relative doc-map for doc-drift validation. Defaults to `.evil-jelly/doc-map.jsonc`.
- `--workspace <dir>`: workspace root for `.evil-jelly/` configuration, audit output, session data, and Agent tool paths. Defaults to the current working directory; relative paths are resolved from the process startup directory.
- `--snapshot <traceId>`: restore a snapshot from a Review trace before entering the session. Mutually exclusive with `--mock`, `--resume`, and `--headless`.
- `--mock <traceId>`: replay an interactive session from a Review trace's model output and snapshot cache. Mutually exclusive with `--snapshot`, `--resume`, and `--headless`.
- `--mock-inputs`: with `--mock`, enqueue user inputs recovered from the trace. Requires `--mock` and cannot be combined with `--input`.
- `--headless`: run UnifiedAgent once without Ink. Requires `--input` and cannot be combined with `--resume`, `--snapshot`, or `--mock`.
- `--auto-accept`: accept tool confirmations in headless test/evaluation runs. Requires `--headless`.
- `--resume [sessionId]`: resume a saved local session by id, or omit the id to choose from this workspace's sessions. Cannot be combined with `--snapshot`, `--mock`, or `--headless`.
- `--input <text>`: supply the first user input without prompting; required by `--headless`.
- **`init --base-url <url>`**: save `OPENAI_BASE_URL` alongside the API key in `~/.evil-jelly/.env`.
- **`init --model <id>`**: save `OPENAI_MODEL_ID` alongside the API key.
- **`audit --family <name>`**: run one read-only audit family without Ink and exit. Required family values: `clone`, `complexity`, `fragmentation`, `doc-drift`, or `doc-sync`.
- **`audit --only-actionable`**: render only actionable findings; statistics still cover the complete run.
- **`audit --max-seeds <n>`**: set a positive limit on new or changed seeds evaluated in this run.
- **`audit --ledger-gc-days <n>`**: prune same-family ledger entries not seen for this positive number of days.
- **`audit --no-ledger-gc`**: disable stale ledger pruning for this run; pruning is enabled by default.
- **`audit --family doc-drift --doc <file>`**: validate one document by basename or workspace-relative path. The partial run does not mark other documents' historical entries as resolved.
- **`audit --family doc-drift --doc <file> --code <path>`**: repeatable; synthesize an in-memory doc-map entry for a trial run. Temporary paths enter the surface hash, so different final map paths trigger reevaluation.

Without a one-shot subcommand, Evil Jelly enters the Ink interface. Enter `exit` to end the session.

### Review and devtool MCP

`pnpm dev` starts with `--review --devtool`, which is useful for dogfooding this repository. Start the devtool server separately:

```powershell
pnpm --filter @rejelly/devtool dev
evil --review --devtool
```

The MCP endpoint is derived from the origin of `REJELLY_REVIEW_ENDPOINT` and defaults to `http://localhost:5789/mcp`. Tools use their own JSON schemas; trace tools generally accept `traceId` and otherwise query the latest trace in the devtool database.

</details>

<details>
<summary><strong>Configuration files: settings.jsonc and doc-map</strong></summary>

### Configuration boundaries

All Evil Jelly configuration lives under `.evil-jelly/`:

- `.evil-jelly/settings.jsonc` contains repository-safe application controls and may be committed.
- `.evil-jelly/doc-map.jsonc` registers documentation sync pairs and doc-to-code mappings and may be committed.
- `.evil-jelly/.env` contains secrets and machine-specific endpoints and should be gitignored.
- CLI arguments apply one-off overrides.

### Workspace settings

`.evil-jelly/settings.jsonc` lives at the Agent workspace root. Every field is optional, so the file may be absent. A malformed file fails loudly. `getSettings()` in `src/shared/settings.ts` is the unified parser; `initSettings` injects CLI overrides at the composition root.

```jsonc
{
  // Per-seed evaluator concurrency for evil audit (default: 12)
  "audit": { "concurrency": 12 }
}
```

Documentation-domain configuration does not belong in settings. It uses the fixed `.evil-jelly/doc-map.jsonc` path unless a one-off `--doc-map` override is supplied.

### doc-map format

JSONC comments and trailing commas are supported. `sync.pairs` supplies symmetrical glob pairs to doc-sync. By convention Chinese is on the left, and the evaluator uses that side as its review spine. `docs` supplies file-level code/artifact mappings to doc-drift. Section-to-symbol matching is derived deterministically and cached in the ledger, rather than maintained manually.

```jsonc
{
  "version": 1, // Fixed at 1
  "sync": {
    "pairs": [
      ["docs/zh/**/*.md", "docs/en/**/*.md"],
      ["examples/**/README.zh-CN.md", "examples/**/README.md"]
    ]
  },
  "docs": {
    // Workspace-relative paths or globs; a key without / is a root-level literal path
    "docs/zh/api/*.md": { "paths": ["packages/core/src/core"] },
    "docs/zh/api/index.md": {
      "paths": ["packages/core/src"],
      "note": "For this overview page, check only factual API claims."
    },
    "packages/jelly-lint/README.md": {
      "artifacts": ["packages/jelly-lint/jellylint.schema.json"]
    },
    "docs/zh/api/legacy.md": { "skip": "Deprecated; explanation for skipping." }
  }
}
```

Another valid mapping:

```jsonc
{
  "version": 1,
  "docs": {
    "packages/*/README.md": { "paths": ["$dir/src"] },
    "apps/evil-jelly/README.md": {
      "paths": ["apps/evil-jelly/src"],
      "note": "Treat the current implementation under src as authoritative for the CLI documentation."
    }
  }
}
```

Use globs for batches and explicit entries for exceptions requiring `note`, `skip`, or `artifacts`. Explicit paths override glob matches regardless of order; among globs, the later entry wins.

| Field | Description |
|-------|-------------|
| `paths` | Workspace-relative prefixes whose exported TypeScript surfaces (signatures + JSDoc) become comparison material. |
| `artifacts` | Files embedded verbatim in the evaluator prompt, such as JSON schemas or `.d.ts` mirrors; useful for non-TypeScript implementations. |
| `skip` | Excludes the document and records the reason. |
| `note` | Adds evaluator guidance, such as allowing an overview to omit details. |

Missing maps do not affect code families. `doc-drift` reports the expected path clearly, while `--doc <file> --code <path>` can run without a map. Existing but malformed maps always fail loudly. See the repository-root `.evil-jelly/doc-map.jsonc` for another reference.

</details>

<details>
<summary><strong>Documentation validation: doc-drift and doc-sync</strong></summary>

### Shared audit workflow

Audits are read-only. A detector produces candidates, a per-seed evaluator determines whether they are actionable, and fan-in writes `.evil-jelly/audit/audit-<timestamp>.md` while maintaining `.evil-jelly/audit/ledger.json`. Selecting one family isolates new detector results from other families' historical noise.

### doc-drift: documentation versus implementation

`evil audit --family doc-drift`:

1. Deterministically splits mapped documents into H1/H2 sections, extracts exported TypeScript surfaces (signatures + JSDoc) and verbatim artifacts, and matches symbols with zero LLM calls.
2. Uses a per-seed evaluator to identify factual drift: `signature-drift`, `default-drift`, `missing-symbol`, `behavior-drift`, or `stale-example`.
3. Treats deliberate simplification or omission (`simplification`) as non-actionable, suppressing it until the document section or mapped surface changes.

```bash
evil --review audit --family doc-drift
evil --review audit --family doc-drift --doc equip.md
evil --review audit --family doc-drift --doc README.md --code apps/evil-jelly/src
evil --review audit --family doc-drift --only-actionable

# Without a global link
pnpm --filter @rejelly/evil-jelly start --review audit --family doc-drift --workspace ../..
```

### doc-sync: bilingual document consistency

The read-only `features/audit/families/docSync.ts` replaced the retired interactive `BiSyncDocsAgent`. There are no shadow copies, direction decisions, or per-file write confirmations.

1. **Deterministic phase, zero LLM calls:** expand both globs in every `sync.pairs` entry and deduplicate the bidirectional union. A file missing on one side produces a high-severity `missing-file` verdict immediately.
2. **Per-seed evaluation:** compare both full documents using the left side as the review spine. Each section is classified as `ok`, `inconsistent`, `left-only`, or `right-only`; the model handles cross-language section alignment.
3. **Fan-in:** share the audit ledger with other families, using both paths as the `fingerprint` and both full texts as the `contentHash`. Reevaluate only when either side changes; suppress non-actionable verdicts according to ledger rules.

The audit never changes files. A downstream agent must add translations or resolve which side is authoritative, consulting source code when necessary.

```bash
evil audit --family doc-sync
evil audit --family doc-sync --only-actionable
```

Each `sync.pairs` value is a `[leftGlob, rightGlob]` pair whose `*` / `**` wildcard shape must match. By convention, Chinese is on the left.

</details>

<details>
<summary><strong>Code architecture and Host protocol</strong></summary>

### Product role and interaction model

Evil Jelly runs `@rejelly/core` in real CLI sessions to validate the same Host protocol, toolchain, and optional Review path used by other hosts. It is both a terminal example application and a reference for future Electron or HTTP integrations. Its tools cover filesystem access, AST inspection, search, unified diffs, optional command execution, and more under `src/tools/`.

Ink renders completed turns once in `<Static>` history and keeps the current input, streaming output, tool status, and Y/n confirmation in a transient bottom area. The React tree is rendered once per process and unmounted only on exit. `logUserMessage` records submitted input immediately, avoiding a visual gap before model output begins. Write diffs appear transiently in `DiffViewer`; after approval, the view disappears and only the Agent's summary enters history.

### Layering

The directory structure is inspired by Feature-Sliced Design. Imports may only point downward:

```text
shared → services → tools → features → shell → cli (entrypoint)
```

| Layer | Directory | Responsibility |
|-------|-----------|----------------|
| **shared** | `shared/` | Cross-feature types and libraries (`AgentShared`, `lib/`, `fs-policy/`). Host-wide registration lives in `services/binding/hostBindings.ts`; shared AST limits live in `shared/lib/heuristicAstLimits.ts`. |
| **services** | `services/` | Domain-agnostic technical services, chiefly heuristic workspace AST parsing under `services/ast/`; no business routing or Agent orchestration. |
| **tools** | `tools/` | Tool definitions, domain kits in `kits.ts`, and middleware without business semantics. |
| **features** | `features/*/` | Domain Agents and logic such as `unified/`, `analyze/`, and `audit/`. |
| **shell** | `shell/` | Top-level session orchestration; `MainCliAgent` directly drives `UnifiedAgent`. |
| **cli** | `cli/` | Ink UI, `runHost`, configuration loading, and the current process's sole entrypoint. |

`MainCliAgent` sends all interactive input directly to `UnifiedAgent`; there is no registry, top-level router, or `--intent`. Read-only and permission scopes are Agent modes/sandboxes, while specialists should be delegated subagents. One-shot audits bypass the interactive session and invoke `AuditAgent` from the `evil audit` subcommand.

`UnifiedAgent` in `features/unified/` handles conversation, explanation, search, implementation, bug fixes, refactoring, file creation, and ad hoc web search; the `cli/` layer does not write files directly. Writes require a displayed unified diff and `confirmWrite`; post-change verification is chosen by the Agent through `run_command`, not an automatic verification pipeline.

A future event-stream-driven `PulseAgent`, inspired by `jellypulse`, may reuse feature-level code agents while splitting long-lived connections, partitions, and quotas across multiple Agents. Future `entrypoints/` may mount CLI and persistent server interfaces; currently only `src/cli/index.ts` is implemented.

### `src/cli` responsibilities

| Path | Responsibility |
|------|----------------|
| `cli/index.ts` | Load the environment, mount Ink `Dashboard`, reset prompt/output sessions, and bind Zustand to `runEvilJellyHost`. |
| `cli/store/useOutputStore.ts` | Store `<Static>` history plus transient `streamBuffer` and `status`; expose `resetOutputSession`. |
| `cli/store/usePromptStore.ts` | Separate `view` (`diff` / `markdown` / `none`) from `prompt` (`line` / `confirm` / `idle`); expose `resetPromptSession`. |
| `shared/types.ts` | Host-protocol types such as `EvilJellyHostBindings`. |
| `shared/config.ts` | Environment, OpenAI adapter, and Review options. |
| `cli/app/host/runHost.ts` | `runEvilJellyHost`, options, and error reporting through `logSystemEvent`. |
| `cli/app/host/runWithReview.ts` | `runWith` and the Review exporter lifecycle. |
| `cli/` | `Dashboard`, transient `TransientPane`, interaction area, `args`, and `io`. |

### Host protocol

The host injects these UI-independent semantics:

| Member | Meaning |
|--------|---------|
| `getInput` | Read one input line at a time. |
| `printOut` | Write current streaming/tool output to the transient buffer, not history. |
| `logUserMessage` | Append user input to history as soon as it is received, before model/routing work completes. |
| `logAssistantMessage` | Append the final response, clear transient output, and restore ready status. |
| `logSystemEvent` | Append startup, farewell, or fatal-error events and clear transient output. |
| `onStatusUpdate?` | Update only the status line without writing history. |
| `confirmTool` | Show a transient highlighted unified diff and request Y/n confirmation. |
| `requestChoice` | Show a generic hotkey menu with an optional transient diff for non-write decisions such as conflict policy. |

</details>
