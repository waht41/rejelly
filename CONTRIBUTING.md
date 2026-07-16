# Contributing to Rejelly

Thank you for contributing to Rejelly. This repository is a pnpm and Turbo monorepo containing the core framework, adapters, developer tools, examples, documentation, and the Evil Jelly reference application.

## Development setup

Prerequisites:

- Node.js 18 or newer
- pnpm 10.28.2
- Rust and Cargo when building or running `jelly-lint`

Install dependencies from the repository root:

```bash
pnpm install
```

Common checks:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint:jelly
pnpm check
```

Prefer focused package or test commands while developing. Run the checks relevant to the affected packages before opening a pull request. Changes that cross package or application boundaries should include `pnpm lint:jelly`, which validates the architecture rules defined by participating workspaces. Current configurations live in `apps/evil-jelly/jellylint.jsonc`, `apps/devtool-server/jellylint.jsonc`, `apps/devtool-ui/jellylint.json`, and `packages/core/jellylint.jsonc`; their schema lives in `packages/jelly-lint/jellylint.schema.json`.

Commits run `pnpm lint-staged` through a Husky pre-commit hook. It applies `biome check --write` to staged JavaScript, TypeScript, JSX, JSON, and JSONC files, so a commit may rewrite staged content or stop when formatting and lint checks fail. Review the resulting diff before retrying a failed commit.

## Branches

Create a short-lived branch from `main` using:

```text
<type>/<short-kebab-description>
```

Common branch types:

- `feat/` for new user-facing behavior
- `fix/` for bug fixes
- `docs/` for documentation
- `refactor/` for behavior-preserving restructuring
- `test/` for test-only changes
- `chore/` for repository maintenance
- `ci/` for CI/CD changes
- `spike/` for exploratory work

Examples:

```text
feat/evil-self-awareness
fix/headless-input-validation
docs/audit-command-guide
refactor/cli-command-registry
```

Keep branches focused on one coherent change. Do not use long-lived feature or contribution branches; `main` is the long-lived integration branch.

## Pull requests and commits

Pull request titles must use the Conventional Commits format:

```text
<type>(<scope>): <summary>
```

Common types are `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, and `perf`.

Use a workspace or product area as the scope when practical, for example `core`, `evil-jelly`, `devtool`, `adapter-openai`, `adapter-mcp`, `create`, `release`, or `repo`.

Examples:

```text
feat(evil-jelly): add structured capability discovery
fix(core): preserve tool results during compaction
docs(adapter-openai): document response API configuration
refactor(evil-jelly): centralize slash command metadata
```

Mark breaking changes with `!` in the pull request title. Explain the migration in the pull request description, and preserve it as a `BREAKING CHANGE:` footer in the squash commit body:

```text
feat(core)!: replace the legacy middleware API

BREAKING CHANGE: middleware handlers now receive a context object.
```

Pull requests are squash-merged, and the pull request title becomes the commit subject on `main`. Commits within a pull request therefore do not need to follow the Conventional Commits format. Keep them readable and reviewable, but temporary subjects such as `wip` or `address review` are acceptable while the branch is in progress.

Before merging, ensure the pull request title accurately describes the complete change. If a pull request will not be squash-merged, every commit that reaches `main` must follow the Conventional Commits format instead.

A pull request should:

- Explain the problem and the chosen solution.
- Identify affected packages or applications.
- Include tests for behavior changes when practical.
- Report the checks that were run.
- Include a Changeset when the change affects a published package.
- Avoid committing API keys, `.env` files, credentials, generated build output, or unrelated local files.

## Changesets

This repository uses [Changesets](https://github.com/changesets/changesets) for package versions and changelogs.

Create a Changeset for a user-visible change to a published package:

```bash
pnpm changeset
```

The currently publishable packages are:

- `@rejelly/core`
- `@rejelly/adapter-openai`, `@rejelly/adapter-gemini`, `@rejelly/adapter-langchain`, and `@rejelly/adapter-mcp`
- `@rejelly/devtool`
- `@rejelly/evil-jelly`
- `@rejelly/limit-model`
- `create-rejelly`

As a general rule, a workspace package is publishable when its `package.json` has a package name and does not set `"private": true`.

Choose the release level according to semantic versioning:

- `patch` for compatible fixes and small behavior improvements
- `minor` for compatible new features
- `major` for breaking public API changes

Pure tests, internal refactors, CI changes, and documentation changes that do not affect a published package generally do not need a Changeset. A commit message does not replace a Changeset.

Do not run `pnpm changeset version` or publish commands in a normal contribution; release maintainers own versioning and publication.

## Documentation and examples

Keep public API documentation and examples aligned with code changes. Where an English and Simplified Chinese document pair already exists, update both sides when the same information is intended for both audiences.

Examples should remain focused, runnable, and free of real credentials. Use placeholders for environment variables and API keys.

## Reporting issues

Before opening an issue, search existing issues for related reports. Include a minimal reproduction, expected and actual behavior, relevant versions, operating system details, and sanitized logs where applicable.

Never include secrets or private source code in an issue, pull request, trace, or log excerpt.

## License

By contributing to Rejelly, you agree that your contributions will be licensed under the [Apache License 2.0](./LICENSE).
