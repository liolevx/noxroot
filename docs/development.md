# Development

Requirements: Node.js `>=22.12 <27`, npm, and Git for lifecycle/worktree integration tests. CI runs
the full matrix on Node 24 across Linux, macOS, and Windows and installed-package smoke tests on
Node 22 and 26 on Linux.

On Windows with Corepack installed, first run `corepack prepare pnpm@10.0.0`. This caches the pinned
test version. The adapter test then runs offline; CI performs preparation as a separate step.

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:built
npm run test:package
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
help/JSON/non-TTY behavior, guided start/finish, autonomy enforcement, strict reviewer output,
package-manager evidence, skill generation/routing, and the application-agent framework boundary.
The package smoke creates a real tarball, installs it in a temporary project, and invokes its actual
platform binary for version and preview checks.

Before adding a dependency, explain why a platform API is insufficient. Production dependencies are
limited to command parsing, schema validation, and YAML. Before claiming a new project shape or
adapter, add a realistic fixture and failure-path coverage.

Publication is not part of ordinary development. The owner must first create the npm package,
configure npm trusted publishing for the exact GitHub repository/workflow on a GitHub-hosted runner,
and authorize adding a publish workflow with `id-token: write`. Do not create or store a long-lived
npm publication token. Trusted publishing automatically supplies provenance for eligible public
packages.
