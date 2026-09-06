---
"@agentskit/code-review": patch
---

Fix GitHub PR batch planning so `--batch-size` reads the full PR file manifest before partitioning, instead of applying the default single-run file cap and silently omitting batches.
