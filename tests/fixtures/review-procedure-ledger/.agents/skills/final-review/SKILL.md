---
name: final-review
description: Review an implementation before completion.
---

# Final review

Keep one task-global round ledger across pauses, compaction, handoff, and resumed work. The
implementation control plane records reviewer dispatches, verification runs, and findings in that
ledger. Continue the same review cycle in a new session instead of resetting its budget.

This procedure reviews repository work. It is not a shared coordination service, session journal,
issue tracker, or work log for coding agents.
