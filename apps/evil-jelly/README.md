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

### Local Skills

Evil Jelly loads local, filesystem-backed instruction Skills from exactly two directories:

```text
~/.evil-jelly/skills/<skill-name>/SKILL.md
<workspace>/.evil-jelly/skills/<skill-name>/SKILL.md
```

The first location supplies personal Skills across workspaces; the second supplies Skills for the
current workspace. Only direct child directories containing `SKILL.md` are discovered. Both roots
are optional, and placing a valid Skill in either root enables it by default. Skills are loaded once
when Evil Jelly starts, so restart the process after adding, removing, editing, enabling, or disabling
one.

Create a minimal project Skill at `.evil-jelly/skills/review/SKILL.md`:

```md
---
name: review
description: Review a change for correctness, regressions, and missing tests.
metadata:
  short-description: Review a change
---

Inspect the relevant diff and surrounding code before reaching conclusions.
Prioritize correctness defects and regressions. Cite concrete files and explain impact.
Mention missing tests after the findings. Do not modify files unless the user asks.
```

`description` is required. `name` is optional and defaults to the directory name;
`metadata.short-description` is optional. Names use lowercase ASCII letters, digits, dots,
underscores, and hyphens, must start with a letter or digit, and are qualified by source as
`user:<name>` or `project:<name>`. If both sources contain `review`, use the qualified name to avoid
ambiguity.

At the interactive prompt, type `$` to open the enabled Skill picker. Selecting an entry inserts an
atomic Skill token such as `$review`; the source qualifier is shown only when names collide. It
applies the full Skill instructions to that input. Ordinary text such as `$HOME`, `${HOME}`,
`$env:PATH`, and an unselected `$unknown` stays ordinary text. The model can also inspect the
bounded catalog with `list_skills`, load one
Skill with `read_skill`, and read an inventoried text resource with `read_skill_resource`.

The interactive CLI also provides read-only local commands that do not call the model:

```text
/skills
/skills list
/skills show <name>
/skills doctor
```

`/skills` opens a keyboard-driven browser for the frozen catalog. Enter opens the selected Skill's
detail panel, including its host filesystem locator and inventoried resources; `O` opens that Skill
folder in the host file manager. `/skills list` prints the same catalog as text, while `/skills show`
accepts a plain or source-qualified name and prints one detail directly. `/skills doctor` performs a
fresh effective scan and reports loading warnings, but does not replace the current session snapshot;
restart Evil Jelly to apply Skill changes.

Outside an interactive session, `evil skills`, `evil skills show <name>`, and `evil skills doctor`
provide the corresponding effective catalog, detail, and fresh diagnostics as versioned JSON. These
commands resolve workspace settings but do not require an OpenAI API key or start an Agent session.

#### Optional Skill resources

A Skill may place supporting files under `references/` and `assets/`. These directories are
inventoried recursively with bounded count, depth, and size metadata. Catalog and resource paths
are Skill-relative POSIX paths. Activating a local Skill through `read_skill` or an explicit Skill
token additionally reveals its canonical host filesystem root so the model can resolve bundled
files. The locator is absent from the catalog, startup summaries, and `read_skill_resource` output.
It grants no permission: reading, modifying, or executing a bundled file still uses the ordinary
host tools, approval, filesystem policy, and sandbox path.

`read_skill_resource` reads only bounded UTF-8 text that was present in the startup inventory;
binary assets may be listed but are not returned as text. Directory symlinks/junctions, file links
that escape the Skill, files outside `references/` and `assets/`, and resources added after startup
are not readable through the Skill resource tool. Ordinary host tools may still access a revealed
local Skill directory when their existing policy allows it.

Skills do not have a plugin manifest, installer, marketplace, configurable extra roots, file
watcher, or hot reload. They cannot declare hooks, dependencies, models, effort, or allowed tools,
and they cannot execute scripts automatically. A Skill may recommend using or editing bundled
files, but it is model instruction content—not a capability or permission grant. Any file, shell,
or MCP call it recommends still follows the existing host registration, approval, and policy path.
An edited `SKILL.md` takes effect after restart because the activated instruction body remains a
startup snapshot.

#### Skill loading diagnostics

Loading problems are isolated: one invalid Skill does not prevent healthy siblings or MCP tools
from working. Startup reports bounded diagnostic-code counts without exposing local Skill paths to
the model. Use the code to apply the corresponding repair:

| Diagnostic | Repair |
|------------|--------|
| `skill.source.invalid` | Make the fixed `skills/` root a readable directory, or remove the invalid root. A missing root is valid and stays silent. |
| `skill.source.duplicate` | Stop the user and project roots from resolving to the same canonical directory. |
| `skill.source.limit-exceeded` | Reduce direct Skill children in that source to 128; excess entries are deterministically omitted. |
| `skill.directory.invalid` | Replace the direct child with a real, readable directory; Skill-directory symlinks and junctions are rejected. |
| `skill.file.invalid` | Add a readable, regular, UTF-8 `SKILL.md` file to the Skill directory. |
| `skill.file.too-large` | Reduce `SKILL.md` to at most 128 KiB. |
| `skill.frontmatter.invalid` | Start and close YAML frontmatter with `---`, provide `description`, use a valid lowercase name, and remove custom tags, anchors, aliases, merge keys, or unsupported control characters. |
| `skill.name.duplicate` | Give colliding Skills within the same source distinct directory/frontmatter names; no ordering-based winner is selected. |
| `skill.load.failed` | Check file permissions and filesystem health, then restart Evil Jelly. |
| `skill.resource.escape` | Remove resource-directory links and file links whose real target leaves the Skill directory. |
| `skill.resource.invalid` | Make the resource resolve to a readable regular file under `references/` or `assets/`. |
| `skill.resource.limit-exceeded` | Keep at most 256 resources per Skill and nesting at no more than 8 directory levels; excess inventory is omitted. |

### Durable sessions

Interactive conversations are saved locally and can be continued with `evil --resume` or the in-session `/resume` command. Sessions are scoped to the active workspace, and the picker shows the most recently updated sessions for that workspace.

New conversations use an append-only JSONL event log. A session file is created only after the first user message is submitted, so opening Evil Jelly to inspect `/status` or exiting immediately does not leave an empty session. Only one process may write a session at a time.

Compaction keeps two views of the conversation:

- The transcript retains the complete user-visible history.
- The active model context uses the latest compacted summary and bounded recent context.

Resuming restores the active context, cumulative usage, and a bounded tail of the transcript without loading the complete UI history into the terminal. Interrupted turns are closed during recovery and are not automatically rerun. In particular, a tool call whose result is unknown is recorded as interrupted rather than executed again.

Pasted images are copied into Evil Jelly's content-addressed blob store when the message is submitted. Session history therefore does not depend on the clipboard's temporary source file. Compaction may omit older images from model context to stay within its token budget, but it does not delete their transcript events or stored blobs.

Legacy `.json` sessions remain visible. The first resume migrates a legacy session to a self-contained V2 `.jsonl` log while leaving the original file unchanged. Migration, corruption, and permission failures stop resume instead of silently falling back to a different copy. History already discarded by legacy compaction cannot be reconstructed.

Session logs are stored under `~/.evil-jelly/sessions/<workspace-bucket>/`; image blobs are stored under `~/.evil-jelly/blobs/`. Evil Jelly does not yet provide session deletion, retention, or blob garbage collection. To remove all locally saved conversations, stop Evil Jelly and delete both directories. Deleting a single session log does not reclaim shared blobs.

### Persistent memory

Persistent Memory is a machine-local, cross-session store for facts and preferences that the user explicitly asks Evil Jelly to remember. It is separate from the current conversation, durable session state, and `@rejelly/core`'s invocation-local `equipMemory`.

Memory has two scopes:

- **Project memory** is the default for a request such as “remember that this repository uses pnpm”.
- **User memory** is shared across workspaces and is used only when the user clearly requests a global preference.

Each entry contains a stable ID, `title`, short self-contained `summary`, and `detail`, plus revision timestamps and provenance. The summary is injected into the model context as a small frozen catalog at session start and after successful compaction. Details and provenance are read progressively with `memory_read` when needed; normal tasks should not call that tool just to list memory. The injected catalog is intentionally frozen within an epoch, so a confirmed edit becomes live immediately but is picked up by the next session or compaction boundary.

Typing `$` in the interactive composer also lists Memory references alongside Skills and MCP servers. A unique Memory title is displayed directly as `$<title>`; `user:` / `project:` is added only when Memory titles collide, and `memory:` is reserved for a collision with another reference kind. The semantic token stores only the stable Memory ID. At submission, Evil Jelly resolves that ID against the live store and freezes its current scope, revision, title, summary, and detail into this user turn; provenance and storage paths are not included. This explicit detail context does not modify the frozen Memory instruction or its prompt-cache prefix, and session resume replays the frozen revision without rereading the store. At most five unique Memories may be selected for one input; a deleted or unavailable selection is frozen as unavailable rather than silently using stale detail.

The Agent has only two Memory tools:

- `memory_read` reads the live catalog or selected details/provenance.
- `memory_edit` proposes one add, update, or delete operation.

Every mutation is shown as an independent confirmation with its exact scope and before/after content. Rejection, cancellation, unavailable confirmation, headless mode, and `--auto-accept` never write memory. Memory is not automatically inferred from ordinary conversation, session summaries, tool output, or code discoveries. Memory tool calls and their results remain visible in the tool transcript.

In an interactive session, use the local commands below; they do not call the model or add messages to conversation history:

```text
/memory
/memory show <id>
/memory edit <id> title <new-title>
/memory delete <id>
```

Bare `/memory` opens the live user/project catalog. Select an entry and press `O` to reveal its concrete scope file in the host file manager (for example, Explorer selects `projects/<project-id>/memory.json`). `/memory show` includes detail and provenance; edit and delete use the same confirmation and compare-and-swap rules as Agent proposals. There is no `/memory list` alias or `/memory add` command. New entries are created by explicitly asking the Agent to remember something.

Memory is stored outside the workspace at:

```text
~/.evil-jelly/memory/
├─ user.json
└─ projects/
   ├─ registry.json
   └─ <project-id>/
      └─ memory.json
```

Project identity is a local UUID registered on this machine. Git helps discover an initial project root and dynamically associate linked worktrees, but Git remotes, branches, `.git` presence, and worktree paths do not directly become the memory identity. Existing registered project boundaries win over later Git topology changes, and worktree aliases are not persisted.

The user home directory is registered as a special `home` project when Evil starts there. It uses the normal project-memory file, never user memory, but matches only the exact home directory. It cannot become an ancestor boundary for repositories below `~`. Legacy registries are migrated in place without moving or rewriting their memory files.

Memory is lower-priority context, not a rule or permission grant. Application safety rules and workspace `AGENTS.override.md` / `AGENTS.md` instructions override it, as does the current explicit user request; project memory is more specific than user memory. Memory files are local machine data and are not included in ordinary workspace file-tool paths. Deleting an entry (or the memory files) does not retroactively remove user messages, tool arguments, or other already-recorded content from session logs or Review traces.

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
evil skills                                # List effective local Skills as JSON
evil skills show project:review            # Show one Skill, including absolute host paths
evil skills doctor                         # Scan Skills and report loader diagnostics

# Interactive local memory commands (inside an `evil` session)
/memory
/memory show <id>
/memory edit <id> title <new-title>
/memory delete <id>
```

For repository development without a global link:

```bash
pnpm --filter @rejelly/evil-jelly start
pnpm --filter @rejelly/evil-jelly start -- audit --family clone --workspace ../..
```

## Configuration

`OPENAI_API_KEY` is the only required setting. The recommended setup is `evil init`; you can also provide it through the shell or `.evil-jelly/.env`. Defaults use the OpenAI-compatible endpoint and `gpt-5.6-luna`.

Without `--env`, environment configuration is resolved in this order: **CLI arguments > shell environment > workspace `.evil-jelly/.env` > `~/.evil-jelly/.env`**. With `--env <profile>`, resolution is **CLI arguments > profile > shell environment > built-in defaults**; workspace and global env files do not fill missing profile values. Non-secret settings use a separate cascade: **CLI arguments > workspace `.evil-jelly/settings.jsonc` > user `~/.evil-jelly/settings.jsonc` > built-in defaults**. Documentation mappings live in `.evil-jelly/doc-map.jsonc`; secrets belong in `.evil-jelly/.env`.

<details>
<summary><strong>Complete environment variables</strong></summary>

### Loading and scope

A regular `.env` at the workspace root is not loaded: it belongs to the application being developed, not to Evil Jelly. When `OPENAI_BASE_URL` or `OPENAI_PROVIDER` comes from a workspace file but `OPENAI_API_KEY` comes from the shell or global file, startup warns that the repository is redirecting a key it does not own. Keep the key and endpoint in the same layer.

`--env <name|path>` selects one explicit file (`evil --env luna` reads `~/.evil-jelly/luna.env`; `evil --env ./ops/staging.env` reads that path). Named profiles sit beside the default `~/.evil-jelly/.env`, which is used only when none is named. A profile groups an endpoint identity: key, model, base URL, proxy, and web-search variables can switch together. Two rules follow:

- Profile values override the same variables from the shell; only `--api-key` overrides the profile. Optional values omitted by the profile can come from the shell, then use built-in defaults.
- Workspace `.evil-jelly/.env` and global `~/.evil-jelly/.env` are not read when a profile is selected, so two env files are never mixed. Ordinary process variables remain available to the OS, child processes, and external integrations.

Every profile must set `OPENAI_API_KEY`, unless the invocation supplies `--api-key`. Startup aborts otherwise instead of borrowing a key from another identity. `evil init --env <name>` creates and updates these files.

When `evil init` finds an existing key, press Enter to retain it. In a TTY it also asks for an optional Base URL and model. For non-interactive endpoint/model setup when the key is already saved (otherwise also pass `--api-key <key>`):

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
| `OPENAI_REASONING_EFFORT` | Thinking budget, sent as `reasoning_effort` and forwarded verbatim (the vocabulary is the provider's: DeepSeek takes `low`/`high`/`max`, OpenAI takes `minimal`…`high`). Unset sends nothing and keeps the provider default. DeepSeek-shaped configurations also get the `thinking` switch, which `none` sets to `disabled`. |
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
| `HTTPS_PROXY` | Highest-priority proxy URL when `USE_PROXY` is enabled. |
| `HTTP_PROXY` | Proxy URL used when `USE_PROXY` is enabled and `HTTPS_PROXY` is unset. |
| `PROXY_URL` | Used when `USE_PROXY` is enabled and neither `HTTPS_PROXY` nor `HTTP_PROXY` is set. Defaults to `http://127.0.0.1:7890`. |

#### Web search

Web search uses the configured LLM endpoint's server-side `web_search` tool. OpenAI-compatible Responses is the default protocol: the tool returns its grounded summary plus cited and consulted sources. The former Anthropic-compatible Messages path remains available with `WEB_SEARCH_LLM_PROTOCOL=anthropic`. `read_webpage` is always loaded for direct URLs, while `web_search` is loaded only when `WEB_SEARCH_PROVIDER=llm`. Web egress proxying is independent from the main LLM API proxy and defaults to a direct connection.

| Variable | Description |
|----------|-------------|
| `WEB_PROXY_URL` | Proxy used only for web fetching; the LLM proxy is not reused by default. |
| `WEB_USE_PROXY` | Set to `true` to reuse `PROXY_URL` for web fetching. |
| `WEB_USER_AGENT` | Identifiable user agent for page fetching. Defaults to `rejelly-web-reader/0.1` with the project URL. |
| `WEB_TIMEOUT_MS` | Per-request timeout in milliseconds (positive integer). Defaults to `15000`. |
| `WEB_MAX_FETCH_BYTES` | Maximum bytes fetched per document (positive integer). Defaults to `2000000`. |
| `WEB_SEARCH_PROVIDER` | Set to `llm` to enable `web_search`; `read_webpage` is always available. |
| `WEB_SEARCH_LLM_PROTOCOL` | `responses` (default) or `anthropic`. An explicit base containing `/anthropic` selects the legacy protocol when this is unset. |
| `WEB_SEARCH_LLM_BASE_URL` | Search API root; defaults to `OPENAI_BASE_URL` for Responses, or `origin(OPENAI_BASE_URL) + /anthropic` for Anthropic Messages. |
| `WEB_SEARCH_LLM_API_KEY` | Search endpoint key; falls back to `OPENAI_API_KEY`. |
| `WEB_SEARCH_LLM_MODEL` | Search model; falls back to `OPENAI_MODEL_ID`. |

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
- `--env <name|path>`: select an explicit env profile above the shell. A bare name resolves to `~/.evil-jelly/<name>.env`, beside the default `.env`; anything containing a separator or ending in `.env` is a path.
- `--review`: enable Review trace export, optionally with `REJELLY_REVIEW_ENDPOINT`.
- `--devtool`: compatibility shortcut that adds the dynamic `evil.devtool` server to the interactive coding run. It uses the same MCP runtime and gateway as configured servers; Audit and headless runs reject it.
- `--doc-map <path>`: workspace-relative doc-map for doc-drift validation. Defaults to `.evil-jelly/doc-map.jsonc`.
- `--workspace <dir>`: workspace root for `.evil-jelly/` configuration, audit output, session data, and relative Agent tool paths. Defaults to the current working directory; relative paths are resolved from the process startup directory. File tools can use outside paths when the filesystem access policy grants or approves them.
- `--snapshot <traceId>`: restore a snapshot from a Review trace before entering the session. Mutually exclusive with `--mock`, `--resume`, and `--headless`.
- `--mock <traceId>`: replay an interactive session from a Review trace's model output and snapshot cache. Mutually exclusive with `--snapshot`, `--resume`, and `--headless`.
- `--mock-inputs`: with `--mock`, enqueue user inputs recovered from the trace. Requires `--mock` and cannot be combined with `--input`.
- `--headless`: run UnifiedAgent once without Ink. Requires `--input` and cannot be combined with `--resume`, `--snapshot`, or `--mock`.
- `--auto-accept`: accept tool confirmations in headless test/evaluation runs. Requires `--headless`.
- `--resume [sessionId]`: resume a saved local session by id, or omit the id to choose from this workspace's sessions. Cannot be combined with `--snapshot`, `--mock`, or `--headless`.
- `--input <text>`: supply the first user input without prompting; required by `--headless`.
- **`init --base-url <url>`**: save `OPENAI_BASE_URL` alongside the API key in `~/.evil-jelly/.env`.
- **`init --model <id>`**: save `OPENAI_MODEL_ID` alongside the API key.
- **`init --env <name>`**: write `~/.evil-jelly/<name>.env` instead of the global `.env`.
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

The MCP endpoint is derived from the origin of `REJELLY_REVIEW_ENDPOINT` and defaults to `http://localhost:5789/mcp`. `--devtool` is mapped once to the ordinary dynamic MCP server contract; it has no separate provider or lifecycle. Tools use their own JSON schemas; trace tools generally accept `traceId` and otherwise query the latest trace in the devtool database.

</details>

<details>
<summary><strong>Configuration files: settings.jsonc and doc-map</strong></summary>

### Configuration boundaries

All Evil Jelly configuration lives under an `.evil-jelly/` directory:

- `~/.evil-jelly/settings.jsonc` contains personal, non-secret defaults across workspaces.
- `.evil-jelly/settings.jsonc` contains local workspace overrides and is ignored by Git.
- `.evil-jelly/settings.example.jsonc` documents workspace settings and may be committed.
- `.evil-jelly/doc-map.jsonc` registers documentation sync pairs and doc-to-code mappings and may be committed.
- `.evil-jelly/.env` contains secrets and machine-specific endpoints and should be gitignored.
- CLI arguments apply one-off overrides.

### User and workspace settings

`~/.evil-jelly/settings.jsonc` supplies user defaults; the ignored `.evil-jelly/settings.jsonc` at the Agent workspace root overrides individual fields for that local checkout. Both files use the same strict schema. Every field is optional, so either file may be absent; a malformed file fails loudly. Copy `.evil-jelly/settings.example.jsonc` when a workspace-local override is needed. `getSettings()` in `src/shared/configuration/settings.ts` resolves each field explicitly, and `initSettings` injects CLI overrides at the composition root.

When the workspace is the user home directory (or its `.evil-jelly` path aliases the global directory), that physical directory is loaded only as user configuration. Project settings, project Skills, project env, and project MCP mutations are unavailable for that run; select another workspace to create project-scoped configuration. Home project memory remains available through its separate UUID-backed memory store.

```jsonc
{
  // Per-seed evaluator concurrency for evil audit (default: 12)
  "audit": {
    "concurrency": 12,
    // Maximum new or changed seeds evaluated per family (default: 24)
    "maxSeeds": 24,
    // Prune same-family ledger entries not seen for this many days (default: 30)
    "ledgerGcDays": 30,
  },
  // Local Skills are enabled by default
  "skills": {
    "enabled": true,
    // Keys must be qualified as user:<name> or project:<name>
    "overrides": {
      "user:review": { "enabled": false },
      "project:release": { "enabled": true },
    },
  },
  "mcp": {
    "servers": {
      "typescript": {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "ts-language-mcp", "."]
        },
        "use": {
          "chat": { "exposure": "explicit", "required": false },
          "audit": {
            "exposure": "always",
            "allow": [
              "get_definition",
              "get_references",
              "get_diagnostics",
              "get_all_diagnostics"
            ]
          }
        }
      }
    }
  }
}
```

Workspace Skill settings replace matching user defaults. The master switch disables every Skill;
an individual `true` cannot bypass it. Disabled Skills do not enter the model catalog or resource
repository. Settings are read into the process-lifetime snapshot, so changes take effect after the
next Evil Jelly start. A `project:<name>` override in user settings applies to every workspace with
that qualified name; put it in workspace settings to affect only the current checkout. This
configuration controls availability only and grants no tool permission.

At the interactive prompt, type `$` to open the enabled Skill picker. Selecting an entry inserts an
atomic Skill token such as `$review`; the source qualifier is shown only when names collide. It
applies that Skill to the current input only. The host carries the selection as structured input
and injects its instructions; ordinary dollar-prefixed text such as `$HOME` or an unselected
`$unknown` remains plain text.

### MCP settings and commands

MCP definitions use whole-server replacement across `user < workspace < dynamic` layers; fields
from two scopes are never deep-merged. Keep secrets in environment variables and reference them
with `{ "fromEnv": "NAME" }`. Workspace definitions require approval of their exact non-secret
configuration fingerprint before they connect. A changed definition invalidates the old grant.

`use.chat.exposure` accepts `off`, `explicit`, or `always`. Every enabled chat server except `off`
is advertised to the Agent by name and can be progressively inspected through `mcp_reference`.
`explicit` still requires a turn/session selection before `mcp_call`; `always` is callable in every
chat turn. Audit is independent and considers only servers with `use.audit.exposure: "always"`;
its `allow` list is mandatory for native tools to be routable. `required: true` blocks only the
corresponding consumer while that server is unavailable.

`mcp_reference` accepts `*` as a bounded visible-tool listing. When a configured server is not
ready, its result reports `unavailableServers` with an `untrusted`, `pending`, `failed`, or
`disabled` status and a `suggestedAction`; these states are not search misses.

For `request_access` or a relevant non-callable match, the Agent uses the fixed `mcp_request`
gateway. The CLI offers server access for this Session or permanently for this workspace. A
Session grant updates the Session V3 selection event; a permanent grant is stored with the exact
host-owned configuration fingerprint. Native `mcp_call` approval is separate and offers once,
this Session, or permanently for this tool in this workspace. Permanent tool grants also bind the
native tool's schema fingerprint, so configuration or schema drift automatically requires a new
decision. The next model dispatch can reference the fresh catalog without requiring a manual
`/mcp use`.

```bash
evil mcp list
evil mcp list --scope user
evil mcp get typescript --scope effective
evil mcp add typescript --scope project -- npx -y ts-language-mcp .
evil mcp disable typescript --scope project
evil mcp enable typescript --scope project
evil mcp remove typescript --scope project
```

Mutations require an explicit `user` or `project` scope and update only that file. During an
interactive session, `/mcp` shows source, exposure, selection, connection, tool count and
fingerprint; `/mcp use <id>`, `/mcp unuse <id>`, and `/mcp reload [id]` manage the live session.
`/mcp permissions` lists permanent workspace grants, while `/mcp revoke <id>` clears permanent
server and tool grants and `/mcp revoke <id>/<tool>` clears one permanent tool grant.
Type `$` and select an MCP server to insert a structured `$mcp:<id>` turn token. Chat models always
see only the stable `mcp_reference`, `mcp_request`, and `mcp_call` gateways; native schemas are
referenced through conversation history and validated again immediately before the native call.
Audit remains non-interactive and exposes only `mcp_reference` and `mcp_call` when configured; it
does not prompt for or write chat grants. Non-interactive hosts likewise never promote a decision
to a permanent grant implicitly.

A stdio `mcp add` requires the explicit `--` separator before its executable. PowerShell's pnpm
shim consumes a bare separator, so quote that token there: `evil mcp add typescript --scope project
'--' npx -y ts-language-mcp .`. Use `--server-cwd <path>` before the separator to set the MCP
subprocess working directory; it defaults to the workspace root.
The default startup timeout is 30 seconds and can be overridden per server with
`startupTimeoutMs`; stdio server diagnostics are captured for status errors rather than written
directly into the interactive terminal.

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

The audit never changes source or documentation files; it only updates its report and ledger under `.evil-jelly/audit/`. A downstream agent must add translations or resolve which side is authoritative, consulting source code when necessary.

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

`MainCliAgent` routes local slash commands such as `/skills`, `/memory`, `/mcp`, `/resume`, and `/status` without a model call; ordinary messages are forwarded to `UnifiedAgent`. Read-only and permission scopes are Agent modes/sandboxes, while specialists should be delegated subagents. One-shot audits bypass the interactive session and invoke `AuditAgent` from the `evil audit` subcommand.

`UnifiedAgent` in `features/unified/` handles conversation, explanation, search, implementation, bug fixes, refactoring, file creation, and ad hoc web search; the `cli/` layer does not write files directly. Writes require a displayed unified diff and `confirmWrite`; post-change verification is chosen by the Agent through `run_command`, not an automatic verification pipeline.

A future event-stream-driven `PulseAgent`, inspired by `jellypulse`, may reuse feature-level code agents while splitting long-lived connections, partitions, and quotas across multiple Agents. Future `entrypoints/` may mount CLI and persistent server interfaces; currently only `src/cli/index.ts` is implemented.

### `src/cli` responsibilities

| Path | Responsibility |
|------|----------------|
| `cli/index.ts` | Load the environment, mount Ink `Dashboard`, reset prompt/output sessions, and bind Zustand to `runEvilJellyHost`. |
| `cli/conversation-display/` | Project conversation events into `<Static>` history, assistant stream, runtime status, live tool tails, and tool transcripts. |
| `cli/message-composer/` | Own the local editable draft and bridge submitted input, available Skills, and restored steer drafts to the host session. |
| `cli/operator-decision/` | Arbitrate and render confirmation, choice, and text decisions independently from message composition. |
| `shared/types.ts` | Host-protocol types such as `EvilJellyHostBindings`. |
| `shared/config.ts` | Environment, OpenAI adapter, and Review options. |
| `cli/app/host/runHost.ts` | `runEvilJellyHost`, options, and error reporting through `logSystemEvent`. |
| `cli/app/host/runWithReview.ts` | `runWith` and the Review exporter lifecycle. |
| `cli/ui/Dashboard.tsx` | Compose the terminal frame from conversation display, operator decision, message composer, and runtime controls. |

### Host protocol

The host injects these UI-independent semantics:

| Member | Meaning |
|--------|---------|
| `getInput` | Read one input line at a time. |
| `printOut` | Write current streaming/tool output to the transient buffer, not history. |
| `logUserMessage` | Append user input to history as soon as it is received, before model/routing work completes. |
| `logAssistantMessage` | Append the final response, clear transient output, and restore ready status. |
| `logSystemEvent` | Append startup, farewell, or fatal-error events and clear transient output. |
| `onPhaseUpdate?` | Report the coarse runtime phase (connecting/thinking/streaming/tool/…) for the status line. |
| `onDetailUpdate?` | Update the status-line detail without writing history. |
| `onTurnStart?` | Anchor the turn timer when an initial user input starts a turn. |
| `confirmTool` | Show a transient highlighted unified diff and request Y/n confirmation. |
| `requestChoice` | Show a generic hotkey menu with an optional transient diff for non-write decisions such as conflict policy. |

</details>
