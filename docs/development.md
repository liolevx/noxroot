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

When working inside the Noxroot source checkout, use `node dist/cli.js` after building. `npx` can
resolve this checkout's package instead of the registry package, without an installed command shim.

Published versions are available on npm. Publication is not part of ordinary development. Future
automated releases require the owner to configure npm trusted publishing for the exact GitHub
repository and workflow, and authorize a publish workflow with `id-token: write` on a GitHub-hosted
runner. That workflow is not configured yet. Do not create or store a long-lived npm publication
token. Trusted publishing supplies provenance for eligible public packages; the first manual release
does not have that provenance. npm's displayed README updates only when a new package version is
published.

## Release checklist

1. Choose the smallest valid semver increment. An npm version cannot be replaced after publication.
2. Update package metadata, the runtime version, version-bound tests, and `CHANGELOG.md` together.
3. Run `npm ci`, `npm run check`, and `npm run package:check` from a clean release branch.
4. Inspect the dry-run file list, package size, executable entrypoint, documentation, and dependency
   set. The packed-install smoke must pass from the produced tarball.
5. Push the candidate and require the complete GitHub matrix before merging.
6. Publish only with explicit owner approval. Then verify the registry version, `latest` tag,
   package integrity, README, and a clean `npx noxroot@<version> --version` invocation.

If publication succeeds but post-publish verification fails, fix forward with another patch version;
never attempt to replace the published artifact.
