---
"@rejelly/evil-jelly": minor
---

Add `--env <name|path>`, which loads one env file above the shell environment; a bare name resolves to `~/.evil-jelly/<name>.env` beside the default `.env`, and `evil init --env <name>` creates and updates it. Moving between models meant hand-editing `.env`, because a model is not one value but an identity — key, endpoint, model id, proxy, and web-search substrate have to move together, and two providers rarely agree on all five. A profile makes that switch atomic.

The profile layer outranks the shell, unlike the workspace and global files, because it is per-run intent rather than a machine fact: naming a profile and silently getting an exported `OPENAI_MODEL_ID` instead is the failure the flag exists to prevent. Only `--api-key` wins over it. Variables a profile leaves unset still fall through to the layers below, so shared knobs stay in one place, but a profile that sets `OPENAI_BASE_URL` or `OPENAI_PROVIDER` without `OPENAI_API_KEY` now aborts startup instead of sending a lower layer's key to the endpoint it redirects to.
