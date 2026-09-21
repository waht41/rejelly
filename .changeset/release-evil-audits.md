---
"@rejelly/evil-jelly": minor
---

### Documentation audits

- Allow doc-drift mappings to select the Markdown heading depth used for audit candidates, include the Evil Jelly README in the audit map, and checkpoint reports and ledger updates as each evaluator settles. ([#82](https://github.com/waht41/rejelly/pull/82))
- Correct audited API and behavior documentation across Evil Jelly and Rejelly in two follow-up passes. ([#85](https://github.com/waht41/rejelly/pull/85), [#108](https://github.com/waht41/rejelly/pull/108))
- Add configurable evaluator timeouts, surface evaluator failures alongside acceptable findings, and expose the Review trace ID as soon as an Audit starts. ([#105](https://github.com/waht41/rejelly/pull/105))
- Skip TypeScript checks for JavaScript clone seeds, validate doc-drift implementation mappings, and retain changed content hashes until their seeds are evaluated. ([#106](https://github.com/waht41/rejelly/pull/106))
