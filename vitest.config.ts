import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/core",
      "packages/limit-model",
      "packages/create/template-*",
      "apps/devtool-server",
      "apps/evil-jelly",
      "examples",
      // packages/adapters/* are excluded on purpose: their E2E suites hit real
      // model APIs, gated on per-package .env files that @rejelly/env/setup
      // resolves from cwd — so they must run with the package dir as cwd.
      // Run them via `pnpm test:model` (or per-package `pnpm test`).
      // packages/jelly-lint is Rust (cargo test) — covered by `turbo run test` only.
    ],
  },
});
