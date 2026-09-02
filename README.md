# Noxroot

Give coding agents the right repository context, checks, and review loop—without loading the whole
codebase.

Noxroot is a local CLI that sits between a task, a repository, and the coding agent you already use.
It diagnoses the project without executing it, selects a bounded set of relevant instructions,
source, tests, and approved checks, then helps close the task with verification, independent review,
and optional validated learning. The default adapter is manual: Noxroot prepares an inspectable
package and invokes no model. A configured command adapter can automate more of the same workflow
within explicit autonomy limits.

What changes in practice:

- task-specific context replaces repeated repository archaeology;
- affected, owner-approved checks replace agent-invented commands;
- a fresh reviewer replaces worker self-approval;
- proposed validated project knowledge replaces raw chat memory;
- explicit autonomy replaces automatic merge or deployment.

This compact result comes from Noxroot's own repository and is checked by the documentation tests:

```text
$ noxroot context "improve reviewer decision safety"
Selected 7 of 101 repository files · ~3,365 tokens
Likely owner: src/adapters/agents.ts
Likely tests: tests/agent-review.test.ts (+1 related)
Approved checks: format-check, lint, typecheck, test, build
Deliberately excluded: 94 unrelated files
```

![Noxroot workflow: repository evidence feeds bounded context, an existing coding agent, approved checks, independent review, and proposed validated learning](docs/assets/noxroot-workflow.svg)

Code, existing docs and instructions, tests, and verification policy feed the workflow. Noxroot
coordinates evidence around your coding agent; it does not contain the coding model.

## Try it safely

Noxroot is not published to npm yet. Try the current source with Node.js `>=22.12 <27`:

```bash
git clone https://github.com/liolevx/noxroot.git
cd noxroot
npm ci
npm run build
node dist/cli.js preview --root tests/fixtures/typescript
```

The stable TypeScript fixture produces this abbreviated preview:

```text
NOXROOT PREVIEW
Detected: Node.js project, TypeScript (npm)
Approved check candidates found: lint, typecheck, test, build
Proposed (7): create 7
Unknown: Continuous integration
Trust: files changed 0; repository commands 0; agent calls 0; network requests 0.

No repository files changed. No project command, agent, or network request ran.
Next: noxroot preview --diff
```

`preview` is read-only and concise. Add `--diff` to inspect every exact proposed patch, then run
`init` only after reviewing it. In a real repository, Noxroot adopts useful existing instructions
and docs by reference or by a hash-guarded managed block; it does not overwrite them to create a
parallel documentation system.

## How a task flows

After initialization, ask for bounded context:

```bash
node /path/to/noxroot/dist/cli.js context "fix reviewer approval parsing" --root /path/to/project
```

At autonomy level 1, `run "task" --guided` records a clean Git baseline, routed context, effective
authority, and the trusted verification policy. Use that portable package with Codex, Claude,
Cursor, or another coding agent. When the change is ready, `finish --task ID` computes the actual
diff, chooses only affected checks from the captured policy, runs them, and builds a reviewer
package. It accepts a strict external reviewer JSON file or invokes a configured reviewer only at
review level 3.

At implementation level 2, an explicitly configured command adapter may run a worker in an isolated
Git worktree. Repair and review calls remain bounded. Level 3 permits independent review. Merge and
delivery are disabled in the MVP regardless of configuration; Noxroot does not push, merge, or
deploy.

After a completed run, `learn --task ID` may propose a typed, evidenced, deduplicated lesson.
Nothing is applied without confirmation. Noxroot prefers executable tests, lint rules, schemas, or
verification policy over prose and keeps runtime sessions, reasoning traces, application memory, and
user data out of project knowledge.

## Commands

| Command                   | Purpose                                               | Default side effect            |
| ------------------------- | ----------------------------------------------------- | ------------------------------ |
| `preview [--diff]`        | Diagnose; optionally show exact setup patches         | None                           |
| `init`                    | Apply the reviewed minimum setup                      | Confirmed project files        |
| `sync --dry-run [--diff]` | Report evidence-backed drift                          | None                           |
| `doctor`                  | Explain configuration, knowledge, and safety problems | None                           |
| `context "task"`          | Build bounded, explainable task context               | None                           |
| `verify --plan`           | Show approved checks without running them             | None                           |
| `verify --changed`        | Run checks affected by the current diff               | Approved processes             |
| `run "task" --guided`     | Start a portable external-agent lifecycle             | Local run record               |
| `finish --task ID`        | Verify and review the guided change                   | Checks and local evidence      |
| `run "task"`              | Use an authorized command adapter                     | Isolated worktree and evidence |
| `learn --task ID`         | Propose controlled durable knowledge                  | None unless confirmed          |

Every data command supports `--json`; diagnostics stay on standard error. See
[the command reference](docs/commands.md) for confirmation rules and exit codes.

## Works with your agent and stack

The manual adapter is vendor-neutral. The generic command adapter receives one JSON package on
standard input and uses a literal executable/argument array—no shell interpolation and no guessed
vendor flags. Noxroot detects npm, pnpm, Yarn, or Bun only from authoritative package-manager
evidence and uses the repository's native scripts. Other stacks use their existing manifests, CI,
tests, evals, and tools.

Application-agent frameworks are detected project architectures, not Noxroot competitors or required
dependencies. Their native tests and evals can become approved checks, and their tools can use the
generic adapter protocol. The MVP does not hard-code or install Agno, PydanticAI, Google ADK, or
another application-agent framework. Framework-specific semantic detectors may be added later as
ordinary built-in analysis modules.

Generated verification and review procedures use the standard `.noxroot/skills/<name>/SKILL.md`
shape. Product/UX review is generated only when applicable or explicitly enabled. Agents without
native Agent Skills discovery can read the same ordinary repository paths.

The committed setup stays small and inspectable. `AGENTS.md` contains a thin entrypoint;
`.noxroot/config.yml` records modules, budgets, autonomy, adapters, and retention;
`.noxroot/routes.yml` describes eligible context paths; `.noxroot/verification.yml` contains only
confirmed command arrays; and `.noxroot/knowledge/INDEX.md` links accepted medium-grained knowledge.
Existing architecture, product, security, testing, contribution, and UX documents are referenced
where they already live. Noxroot does not generate duplicate `.claude`, `.agents`, `.cursor`, or
framework-specific skill trees.

Removal is equally ordinary: remove the thin entrypoint reference and Noxroot-owned configuration,
routes, policy, and skills. Preserve or relocate accepted project knowledge unless its owner chooses
to remove it. Review local run evidence and any active worktree separately; never delete dirty work
as part of uninstalling repository metadata. There is no hosted account, remote knowledge store, or
hidden repository service to dismantle.

## Trust boundaries

During `preview`, Noxroot performs bounded filesystem inspection only: no repository writes, Git or
project commands, agent calls, network requests, telemetry, symlink traversal, or suspected-secret
reads. JSON reports confirmed, unknown, conflicting, and incomplete evidence instead of filling gaps
with guesses.

Execution uses repository-contained working directories, direct argument arrays, timeouts,
cancellation, a minimal environment, and bounded output. Verification trust is captured before a
worker runs, so a worker-created policy cannot authorize itself. No matching or available approved
check means blocked, not approved. Automated reviewers must return one schema-valid JSON object;
prose and ambiguous output are blocked.

Noxroot project knowledge is strictly separate from application runtime sessions, state, memory, and
user data. Local run evidence lives under Git's common directory (or a per-user state directory for
non-Git projects), not in committed knowledge. Read the exact boundaries in
[security](docs/security.md), [architecture](docs/architecture.md),
[configuration](docs/configuration.md), and [adapters](docs/adapters.md).

## Status, help, and contribution

Version 0.1 is an experimental MVP. Context routing is deterministic rather than embedding-based;
framework-specific semantics and vendor adapter profiles are deferred; delegated isolation requires
Git and a commit. Supported Node versions are tested with Node 24 across Linux, macOS, and Windows,
plus Node 22 and 26 package smokes on Linux.

Run `noxroot doctor` for repository-specific problems or open a
[GitHub issue](https://github.com/liolevx/noxroot/issues). Read [CONTRIBUTING.md](CONTRIBUTING.md)
before contributing and report vulnerabilities through [SECURITY.md](SECURITY.md). Apache-2.0; see
[LICENSE](LICENSE).
