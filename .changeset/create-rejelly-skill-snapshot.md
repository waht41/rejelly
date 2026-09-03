---
"create-rejelly": minor
---

Scaffold a portable `.agents/skills/rejelly` Skill alongside `AGENTS.md`, including a committed, release-matched snapshot of the Rejelly documentation for progressive offline reference. Generate both forms of AI guidance from the canonical docs during development and verify the committed outputs for drift in CI.

Support positional project names plus `--template`, `--adapter`, and `--yes` for automation. Complete arguments now scaffold without prompts, while incomplete non-interactive invocations fail immediately instead of waiting on stdin.
