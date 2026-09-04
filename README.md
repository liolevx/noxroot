<p align="center">
  <img src="docs/assets/noxroot-logo.svg" alt="Noxroot" width="100%">
</p>

<p align="center">
  <a href="https://github.com/liolevx/noxroot/actions/workflows/ci.yml"><img src="https://github.com/liolevx/noxroot/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
</p>

# Noxroot

**Give coding agents the project context they need, then check what they changed.**

A CLI for project memory, focused task briefs, approved checks, and reusable documentation.

Noxroot carries repository knowledge across sessions, prepares a small task brief, checks the
resulting diff with approved commands, and proposes useful documentation for the next task.

It reuses the docs, rules, skills, and checks your repository already has. Use it with Codex, Claude
Code, Cursor, OpenCode, Copilot CLI, and other coding agents.

## What Noxroot changes

| Without Noxroot                                        | With Noxroot                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Each new session rediscovers the repository            | Every task starts from the same documented project knowledge                        |
| Too much code is loaded or an important file is missed | The agent gets a small, explainable task brief                                      |
| Checks are guessed, skipped, or reported vaguely       | Approved checks run against the actual diff                                         |
| Decisions and fixes disappear into old chats           | Useful lessons are proposed as Markdown and carried into future tasks once accepted |
| The workflow depends on one coding tool                | The core works through a CLI, Markdown, JSON, and a command adapter                 |

New chats do not require another `init`. Ordinary questions need no Noxroot task. Noxroot stays in
the background until code-changing work needs it.

Inspect the relevant files and checks before the agent starts editing:

<p align="center">
  <img src="docs/assets/noxroot-terminal.png" alt="Noxroot terminal example: preserve project filters on back navigation, with likely source files, a navigation test, and checks to run" width="594">
</p>

Output excerpt with illustrative project paths and checks, not a captured test run. The brief
identifies likely source files, related tests, and commands to run. It does not claim those checks
have passed.

## Project memory, not chat history

Project memory is the versioned repository knowledge future agents should reuse: architecture,
conventions, decisions, procedures, and validated lessons. It is stored as ordinary Markdown, not
model memory or chat history.

Noxroot starts with the repository's existing documentation and source. Its index points agents to
relevant material instead of copying it into a parallel wiki. Validated lessons keep project
documentation current. If no reusable lesson exists, nothing is added. Completed local run evidence
expires after the configured retention window and is capped by count. Active and incomplete work is
preserved.

Read project knowledge in GitHub, your editor, or Obsidian. It excludes raw prompts, application
sessions, credentials, and user data.

## Checks that match the change

During setup, Noxroot looks for existing lint, type-check, test, build, and native eval commands.
Legacy or custom commands may need explicit configuration. You approve which may run. `finish`
applies the relevant checks to the changed paths. Wider or sensitive changes can require independent
review.

Noxroot shows which files changed, which commands ran, what passed or failed, and anything it could
not verify. A missing relevant check produces `incomplete`, never `approved`. Inspect the exact plan
before it runs with `noxroot verify --plan`.

## Set up once

```bash
npx noxroot@latest init
```

Then keep talking to your coding agent normally:

```text
Fix project filters resetting on back navigation.
```

For a code-changing task, compatible agents are instructed to use the pinned repository commands
behind the scenes:

```bash
npx --yes noxroot@0.1.0 start "fix project filters resetting on back navigation"
# your existing coding agent builds the change
npx --yes noxroot@0.1.0 finish
```

Run `init` once per repository. It previews a thin managed entrypoint, preserves existing
documentation, and pins the Noxroot version. The pinned `npx` command needs no global or project
installation.

Before setup, preview labels each capability `create`, `reuse`, `adjacent`, `conflict`, or
`not-assessed`. Noxroot creates only a confirmed gap. Existing systems stay in place. Missing
evidence means no change. If another tool already coordinates repository changes, Noxroot can add
non-overlapping context and verification support while that tool keeps ownership of task lifecycle,
review, and learning. A coordination ledger or session journal is reported as adjacent: it may
preserve work across sessions, but Noxroot does not import its log or treat it as a development
coordinator.

Questions, explanations, reviews, and other read-only work do not create tasks. If a new
conversation continues the same task in the same repository, branch, and worktree, `start` reuses
the active baseline instead of creating a duplicate. `finish` finds the task when exactly one
matches. If several tasks match, Noxroot lists them and requires `--task <id>` instead of guessing.
Instruction discovery varies by coding tool, so the commands remain available for manual use.

### What setup can add

| Surface                           | Actual path or command                                                                                      | Purpose                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Agent entrypoint and config       | `AGENTS.md`, `.noxroot/config.yml`                                                                          | Connect compatible agents to the project workflow                        |
| Project-memory index              | `.noxroot/knowledge/INDEX.md`                                                                               | Route agents to relevant existing documentation                          |
| Task-context routes               | `.noxroot/routes.yml`                                                                                       | Select relevant files, rules, tests, decisions, and skills               |
| Verification policy and skill     | `.noxroot/verification.yml`, `.noxroot/skills/verify-change/SKILL.md`                                       | Define approved checks and the procedure for checking a change           |
| Review skills                     | `.noxroot/skills/independent-review/SKILL.md`, `.noxroot/skills/product-ux-review/SKILL.md` when applicable | Provide fresh review procedures when the change requires them            |
| Learning procedure after finish   | `finish`, then `learn` through the pinned `npx` command                                                     | Propose a small knowledge update when something reusable was validated   |
| Local task state created by start | `.noxroot/local/runs/*.json` in a new Git checkout                                                          | Store ignored baselines and results, separate from project documentation |

Only missing capabilities are proposed. Mature repositories may need nothing. Existing documentation
remains discoverable without being copied.

Existing `.git/noxroot` records stay in place, without a second store. If an agent cannot write task
state, it must stop and request access before continuing.

`SKILL.md` files are portable, on-demand instructions. The generated verification skill tells an
agent how to check a change; the independent-review and optional product/UX skills describe their
reviews. Context loading comes from `AGENTS.md`, the knowledge index, and context routes, not a
generated context skill. Learning comes from `finish` and `learn`, not a generated learning skill.

Skills are instructions, not test evidence. Incomplete work cannot become approved. Noxroot does not
push, merge, publish, or deploy.

`context "<task>"` is read-only. It does not start a task or run checks. Selection is advisory, not
permission to edit. "Do not deploy" remains an exclusion; it never activates deployment work. Use
`start` to record the task baseline and `finish` to check the resulting change.

Large files get bounded line ranges when relevant text is found. Partial context is labelled; agents
still inspect the surrounding code. Existing routes stay unchanged.

## Try the read-only diagnosis

Noxroot is not published to npm yet. From source, use Node.js `>=22.12 <27`:

```bash
git clone https://github.com/liolevx/noxroot.git
cd noxroot
npm ci
npm run build
node dist/cli.js preview --root tests/fixtures/typescript
```

The fixture produces this abbreviated output:

```text
NOXROOT  preview

Detected
  Node.js · TypeScript · npm

Mode
  Full

Add
  Project knowledge
  Task routes
  Verification
  Verification skill
  Task orchestration

Not assessed
  Product and UX guidance

No files changed. No project commands or agents ran. No network requests were made.

Next
  npx --yes noxroot@0.1.0 preview --diff
```

Use `preview --diff` to inspect every proposed setup patch. The intended beta entry point is
`npx noxroot@latest preview`.

## Portable by design

Noxroot's universal interface is the CLI plus generated Markdown and JSON. Any agent that can run a
command or read a task package can use it. The generic adapter accepts an explicit executable and
literal arguments. It does not guess vendor flags or use shell interpolation.

Instruction discovery varies by client. Some tools read `AGENTS.md`, others use their own files, and
some require manual invocation. Noxroot does not claim equal native integration everywhere.

Application-agent frameworks are detected project architectures, not competitors or dependencies.
Their tests and evals can become approved repository checks. Noxroot does not install or control
Agno, PydanticAI, Google ADK, LangGraph, or another application runtime. Project knowledge remains
separate from application runtime sessions, state, memory, and user data.

JavaScript package evidence supports npm, pnpm, Yarn, and Bun. Explicit verification arrays support
Python, Go, Rust, and other stacks. CI covers Windows, macOS, and Linux.

## Inspect the details when you need them

`--verbose` shows detailed human-readable evidence. `preview --diff` shows proposed writes.
`context` explains file selection. `verify --plan` shows approved commands without running them.
`verify --changed` runs applicable checks. `run --dry-run` shows a connected execution plan.
`status` shows active work and the next action. `doctor` explains configuration problems.
`learn --task ID` shows confirmable durable proposals. Data commands support `--json`, with progress
and diagnostics on standard error.

Read the [command reference](docs/commands.md), [configuration](docs/configuration.md),
[architecture](docs/architecture.md), [adapter protocol](docs/adapters.md), and
[security boundaries](docs/security.md).

Noxroot is an experimental v0.1 MVP. Apache-2.0; see [CONTRIBUTING.md](CONTRIBUTING.md),
[SECURITY.md](SECURITY.md), and [LICENSE](LICENSE).
