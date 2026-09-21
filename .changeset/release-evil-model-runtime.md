---
"@rejelly/evil-jelly": patch
---

### Model and conversation runtime

- Scope cancellation to the active conversation, agent, turn, or tool operation so interrupting in-flight work does not discard unrelated conversation state or newly submitted user input. ([#83](https://github.com/waht41/rejelly/pull/83))
- Recover interactive sessions from transient network failures and expose retry backoff, active attempts, and stable failure reasons in the runtime status bar. ([#90](https://github.com/waht41/rejelly/pull/90))
