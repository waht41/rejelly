---
"@rejelly/evil-jelly": patch
---

Build the published CLI with a single bundled production React runtime, including Ink and Zustand hooks, to prevent development-only performance measurements from accumulating during long interactive sessions. Keep source development mode and explicit startup/composer profiling available without changing the user's runtime environment.
