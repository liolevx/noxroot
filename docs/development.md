# Development

Requirements: Node.js 24 LTS, npm 11.5.1 or later for future trusted publishing, and Git for
worktree integration tests.

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run package:check
```

The committed fixtures cover an empty directory (created during tests), empty Git repository
primitives, JavaScript, TypeScript, a TypeScript workspace, Python, Rust, a browser project with
Playwright configuration, no-test projects, existing documentation and agent instructions,
conflicting instruction files, dirty Git state (created during tests), non-Git projects, ignored
generated directories, symlink escapes (created during tests), suspected secrets, and malformed
Noxroot configuration.

Tests cover preview invariance/no execution/determinism/secrets/paths, initialization
preservation/cancellation, context budgets, verification trust, direct process behavior, worktree
isolation, worker/check/reviewer/repair ordering, learning confirmation and deduplication, CLI
help/JSON/non-TTY behavior, and the application-agent framework boundary. CI runs the supported
operating-system matrix and performs package-content inspection on Linux.

Before adding a dependency, explain why a platform API is insufficient. Production dependencies are
limited to command parsing, schema validation, and YAML. Before claiming a new project shape or
adapter, add a realistic fixture and failure-path coverage.

Publication is not part of ordinary development. The owner must first create the npm package,
configure npm trusted publishing for the exact GitHub repository/workflow on a GitHub-hosted runner,
and authorize adding a publish workflow with `id-token: write`. Do not create or store a long-lived
npm publication token. Trusted publishing automatically supplies provenance for eligible public
packages.
