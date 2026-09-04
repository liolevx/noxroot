# Changelog

## 0.1.1 — 2026-09-04

This patch release strengthens the existing Noxroot workflow without adding a new command or
expanding its product boundary.

### Fixed

- Bind verification, independent review, and learning to the complete current repository change.
- Refuse completion when changed paths lack an approved check or when the repository changes while
  checks or review are running.
- Bind reviewer responses to a task and change ID; reject stale, mismatched, linked, tracked, or
  oversized external review evidence.
- Preserve mixed positive and negative task constraints instead of dropping requested outcomes.
- Improve context selection for SvelteKit and native C implementations while keeping selection
  bounded and explainable.
- Distinguish real package-manager or instruction conflicts from unrelated mentions and thin
  forwarding files.
- Keep timeout failures concise but actionable with the command, working directory, limit, and
  bounded final output.
- Allow dedicated local review evidence beside legacy task records while still refusing two actual
  task-state stores.

### Validated

- Reusable learning is admitted only from an approved, unchanged diff and is selected for related
  future tasks without being duplicated or injected into unrelated work.
- Existing documentation, Agent Skills, verification wrappers, Director-style ledgers, and
  repository coordinators are reused, treated as adjacent, or reported as conflicts according to
  their actual responsibility.
- Package installation and lifecycle tests run across Windows, macOS, Linux, and Node.js 22, 24, and
  26 in CI.

`0.1.0` remains the first public npm release. No migration, background service, telemetry, or new
agent framework is introduced by `0.1.1`.
