# Noxroot

CLI that builds repository context for coding agents, coordinates implementation and review, runs
relevant checks, and preserves validated learnings.

**Status: experimental MVP**

```bash
npx noxroot preview
```

`preview` performs a bounded, deterministic diagnosis and prints every file Noxroot would propose.
The Noxroot process does not modify the repository, run project commands, call an agent, make a
network request, read through symlinks, or display suspected secret contents. `npx` may download the
package before it starts; install Noxroot locally and invoke it offline if that package-manager
network behavior is not acceptable.

This excerpt is generated from the automated TypeScript fixture:

```text
NOXROOT PREVIEW
Read-only repository diagnosis

Repository files changed: 0
Repository commands executed: 0
Agent calls made: 0
Network requests made by Noxroot: 0

Detected
✓ [confirmed] Node.js project — package.json
✓ [confirmed] TypeScript source — tsconfig.json

Proposed changes: 7 files

No repository changes were made.
```

## What it does

- Builds a bounded repository profile with evidence marked `confirmed`, `declared`, `inferred`,
  `unknown`, or `conflicting`.
- Routes a task to relevant instructions, project knowledge, source, tests, and approved checks
  while reporting exclusions and estimated context size.
- Coordinates one worker and an independent reviewer through a manual or explicit local command
  adapter, with small call and repair budgets.
- Runs only owner-confirmed verification commands and records exact bounded evidence and gaps.
- Proposes durable learning after a completed run; it does not save chats, reasoning traces, runtime
  user data, or routine summaries.

## Read-only preview

During `preview`, Noxroot does not write or touch repository files; create `.noxroot/` or temporary
repository files; change Git state; run Git, tests, builds, scripts, hooks, package managers,
project binaries, migrations, or agents; make network requests; or enable telemetry. It reads a
bounded set of manifests, configuration, instruction files, documentation indexes, and conventional
source/test paths. It respects built-in exclusions and `.gitignore`, does not follow symlinks, and
identifies suspected secrets by filename without reading their contents.

Every fixture test hashes repository-visible state before and after preview. Inspection limits are
reported as incomplete results rather than hidden extrapolation. See
[the security model](docs/security.md) for the precise boundary.

For offline use after a local install:

```bash
npm install --save-dev noxroot
./node_modules/.bin/noxroot preview
```

## Quick start

In an existing repository:

```bash
npx noxroot preview
npx noxroot init
npx noxroot context "add a health-check endpoint"
npx noxroot verify --plan
npx noxroot run "add a health-check endpoint" --guided
```

In an empty repository, preview enters bootstrap mode. It proposes only `AGENTS.md`,
`.noxroot/config.yml`, and `.noxroot/knowledge/INDEX.md`; it does not invent a product,
architecture, test command, deployment model, or browser journey. After real code is scaffolded, run
`noxroot sync --dry-run` and inspect the new evidence-backed proposals.

`init` and mutating `sync` display complete patches and require an interactive confirmation. For
automation, `--yes` means that the displayed proposal has already been reviewed; non-interactive
execution otherwise cancels without writing.

## How it works

```text
preview (read only)
  → confirmed initialization
  → bounded task context
  → isolated worker worktree
  → approved deterministic checks
  → independent reviewer
  → at most one default repair pass
  → evidence-backed handoff
  → optional confirmed learning
```

Levels 0–3—preview, guided, delegated, and reviewed—are represented in configuration. Merge and
delivery levels are schema-reserved but capped at disabled MVP behavior. Noxroot never pushes,
merges, or deploys.

## Commands

| Command                        | Purpose                                                | Side effects                                                    |
| ------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------- |
| `noxroot preview`              | Diagnose and show complete proposed patches            | None                                                            |
| `noxroot init`                 | Create the confirmed minimum setup                     | Confirmed repository files                                      |
| `noxroot sync --dry-run`       | Report drift and newly justified files                 | None                                                            |
| `noxroot doctor`               | Report invalid config, unsafe paths, limits, and drift | None                                                            |
| `noxroot context "task"`       | Build an explainable, bounded context package          | None                                                            |
| `noxroot verify --plan`        | Show approved relevant checks                          | None                                                            |
| `noxroot verify --changed`     | Run approved checks routed from current changes        | Approved processes and local evidence                           |
| `noxroot run "task" --dry-run` | Show calls, budgets, checks, scope, and prohibitions   | None                                                            |
| `noxroot run "task" --guided`  | Emit a portable manual task package                    | None                                                            |
| `noxroot run "task"`           | Coordinate an explicitly configured command adapter    | Isolated branch/worktree, agent/check processes, local evidence |
| `noxroot learn --task ID`      | Propose evidenced, deduplicated consolidation          | None unless `--apply` is confirmed                              |

All commands support `--help`; data-producing commands support global `--json`, and output is
uncolored when `--no-color` or `NO_COLOR` is set. JSON goes to standard output and diagnostics go to
standard error. Redirecting output does not grant confirmation or change behavior. Exit codes are
documented in [commands.md](docs/commands.md).

## What Noxroot creates

Committed project files are ordinary Markdown and YAML, created only when justified:

```text
AGENTS.md
.noxroot/
├── config.yml
├── routes.yml                 # when useful routes are confirmed
├── verification.yml           # when discovered commands are confirmed
└── knowledge/
    ├── INDEX.md
    └── architecture.md         # only with implementation evidence
```

Accepted decisions, UX knowledge, procedures, and learnings are added only when they have real
evidence and future value. Temporary run state is not committed. In Git repositories it lives under
`<git-common-dir>/noxroot/{runs,evidence,locks,worktrees}`; non-Git projects use a per-user state
directory keyed to the canonical repository path.

To remove Noxroot, first remove its thin entrypoint references, then remove `.noxroot/config.yml`,
routes, and verification policy. Preserve or relocate user-authored `.noxroot/knowledge/` by
default. Remove local run evidence separately after reviewing retention needs; never delete an
active or dirty worktree.

## Worker and reviewer flow

The default adapter is `manual`, which invokes nothing. A configured command adapter receives a JSON
task package on standard input; Noxroot never builds a shell string or places the task text in
command arguments. Delegated runs require a Git repository with a commit, show their exact plan,
preserve the current checkout, and create a collision-resistant `noxroot/<task>-<id>` branch in an
isolated worktree.

After the worker returns, Noxroot runs the verification policy captured before the worker started. A
worker-created verification command cannot authorize itself. Only after deterministic checks pass
does a separate reviewer invocation receive the original brief, bounded diff, evidence, rubric, and
known gaps. The final handoff names what changed, what passed, what was not verified, review
findings, risks, branch/worktree, and next commands.

## Repository knowledge and Obsidian

Markdown, YAML, Git, source, tests, and public contracts are canonical. Obsidian can open the
knowledge directory but is optional. Compared with a plain `AGENTS.md`, Noxroot adds deterministic
diagnosis, task routing, bounded coordination, verification evidence, and controlled consolidation
while continuing to use ordinary inspectable files.

Application-agent frameworks are detected project architectures, not Noxroot competitors or
dependencies. Their native tests/evals can be approved through normal verification policy, and their
tools can be invoked through the generic command adapter. Noxroot project knowledge is strictly
separate from application runtime sessions, state, memory, and user data. The MVP does not install
or hard-code Agno, PydanticAI, Google ADK, or another application-agent framework.

## Verification

Manifest scripts, CI, and conventional tooling produce candidates; discovery alone is not trust.
`init` can place exact executable/argument arrays into `.noxroot/verification.yml` only as part of
the displayed, confirmed patch. Routing selects the smallest justified approved set from changed
paths. Evidence contains executable, arguments, working directory, timestamps, duration, exit
status, bounded output, timeout/truncation state, and declared gaps.

Passing checks are evidence of the exercised behavior, not a claim of overall correctness. Browser
QA reuses an existing compatible adapter such as Playwright; preview never installs it. Non-browser
projects use their native CLI, API, library, mobile, or compiled-language checks.

## Agent compatibility

The MVP ships a vendor-neutral `manual` adapter and a configurable local `command` adapter.
Vendor-specific CLI flags are not frozen or guessed. A command adapter declares one executable and
an argument array, receives the role and task package over standard input, runs without a shell, and
is subject to repository working-directory, timeout, cancellation, environment, and output limits.
See [adapters.md](docs/adapters.md).

## Trust, privacy, and security

Noxroot requires no account and contains no telemetry. Preview makes no runtime network request and
sends no repository data anywhere. Repository text and agent output are treated as untrusted data;
only designated configuration/instruction locations receive semantics. Suspected secrets are never
loaded into context or output. Process execution uses direct argument arrays and a minimal inherited
environment, and no MVP path weakens OS, Git, CI, agent, or sandbox permissions.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Current limitations

- Tested project shapes are empty/non-Git/Git repositories; small JavaScript and TypeScript
  projects; TypeScript workspaces; Python; Rust; and browser projects with existing Playwright
  configuration. This is not a claim that every repository is supported.
- `.gitignore` matching covers common anchored, directory, wildcard, and negation forms but is not
  yet a byte-for-byte reimplementation of Git's matcher.
- Context routing is deterministic path/evidence scoring, not semantic embeddings or hosted
  retrieval.
- The command adapter protocol is local and generic; no vendor-specific profile is claimed.
- Browser/product review hooks are represented by applicability and verification routes; Noxroot
  does not install browsers or generate uncontrolled screenshot matrices.
- Worktree isolation requires Git and at least one commit. Non-Git projects use guided/manual flow
  in this MVP.
- Schema version 1 rejects unknown versions; no historical migration is needed yet.

## Configuration

The minimal configuration is versioned and validated with path-specific errors:

```yaml
version: 1
modules: [repository-profile, agent-routing, verification, orchestration, learning]
roots: [.]
context:
  budgetBytes: 48000
agents:
  default: manual
  adapters:
    manual:
      type: manual
autonomy:
  default: 0
  implementation: 2
  review: 3
  merge: 0
  delivery: 0
```

See [configuration.md](docs/configuration.md) for command adapters, budgets, retention, and
verification arrays.

## Development

Node.js 24 LTS is the supported runtime.

```bash
git clone https://github.com/liolevx/noxroot.git
cd noxroot
npm ci
npm run check
npm run package:check
node dist/cli.js preview --root tests/fixtures/typescript --no-color
```

The fixture suite verifies safety claims and the fake deterministic adapter verifies worker → checks
→ independent reviewer → bounded repair → handoff. Development details and the fixture matrix are in
[development.md](docs/development.md).

## Contributing and security reporting

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change. Security reports should follow
[SECURITY.md](SECURITY.md), not a public issue containing exploit details or secrets.

## License

Apache-2.0. See [LICENSE](LICENSE).
