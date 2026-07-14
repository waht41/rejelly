# Release tools

This repository uses [Changesets](https://github.com/changesets/changesets) to record
package changes, update versions and changelogs, and publish releases.

## Changesets

- `pnpm changeset` creates a changeset for the packages changed by a pull request.
- `pnpm changeset version` consumes pending changesets and updates package versions and changelogs.
- `pnpm release:local` builds and publishes to the local verdaccio registry for smoke-testing before going public.
- `pnpm release` verifies the target registry (npmjs), builds the workspace, and publishes unpublished versions.

## Repository release helpers

The private `@rejelly/release-tools` workspace package provides additional release checks:

- `release:prepare` reports packages changed since their latest release tags.
- `release:pack-hash` compares local package contents with an already published version.
- `release:check-registry` verifies that every publishable package resolves to the expected registry.
- `release:canary` builds and publishes commit-based prereleases to a non-public registry.

Run a helper through its workspace package, for example:

```sh
pnpm --filter @rejelly/release-tools release:prepare
pnpm --filter @rejelly/release-tools release:pack-hash --all
pnpm release:canary -- --dry-run --all
```
