---
"@rejelly/evil-jelly": minor
---

Add `--env <name|path>`, which selects one explicit env file above the shell; a bare name resolves to `~/.evil-jelly/<name>.env` beside the default `.env`, and `evil init --env <name>` creates and updates it. Moving between models meant hand-editing `.env`, because a model is not one value but an identity — key, endpoint, model id, proxy, and web-search substrate have to move together, and two providers rarely agree on all five. A profile groups that switch in one file.

Profile values override the same shell variables, and only `--api-key` wins over a selected profile. Values omitted by the profile can come from the shell, but workspace and global env files are skipped so two files are never mixed. A profile without its own `OPENAI_API_KEY` still aborts startup unless `--api-key` supplies one; API keys are not borrowed implicitly from the shell.
