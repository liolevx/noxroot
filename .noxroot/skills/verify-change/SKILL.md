---
name: verify-change
description:
  Verify an actual repository change with approved evidence; use after implementation and before
  handoff or review.
---

# Verify a change

1. Inspect the actual diff and the task acceptance criteria.
2. Use Noxroot's approved verification plan. Do not invent commands, install tools, or change policy
   merely to pass.
3. Exercise the real product surface only when a relevant repository adapter already exists and is
   approved.
4. Record each exact command, status, and bounded evidence. Identify unavailable or unmatched checks
   as gaps.
5. Never treat one passing check as proof of total correctness.

Return a concise structured result with changed surfaces, checks and statuses, evidence, gaps,
residual risks, and the next required action.
