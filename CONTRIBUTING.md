# Contributing

Open an issue before broadening the public contract, security model, or dependency set. Keep changes
narrow, add evidence-backed tests, and preserve the read-only preview guarantee. Run `npm run check`
and `npm run package:check` before proposing a change.

Do not commit credentials, private data, generated dependency trees, raw agent transcripts, or
application runtime sessions/state/memory. New detection must be deterministic and bounded. New
executable behavior must remain separate from discovery and require explicit verification or adapter
configuration.
