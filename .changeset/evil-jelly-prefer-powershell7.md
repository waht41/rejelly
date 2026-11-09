---
"@rejelly/evil-jelly": patch
---

Prefer PowerShell 7+ for Windows run_command executions when pwsh is available, falling back to Windows PowerShell when interpreter detection fails. Cache the selected interpreter and keep Environment syntax guidance aligned with it; command failures never trigger shell fallback or re-execution.
