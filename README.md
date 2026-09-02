<p align="center">
  <img src="docs/assets/noxroot-logo.svg" alt="Noxroot" width="100%">
</p>

# Noxroot

**Project memory and orchestration for the coding agent you already use.**

Your coding agent changes. Your project memory should not.

Noxroot is a local, open-source layer that prepares an agent before it codes, checks the result
afterward, and carries useful project knowledge into the next task. It works with your existing
agent and repository. It does not provide a model, replace Git, or take ownership of your project.

## What Noxroot changes

| Without Noxroot                                         | With Noxroot                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Each agent session rediscovers the repository           | Every task starts from the same durable project memory                                                    |
| Too much code is loaded or the important file is missed | The agent gets a small, explainable context package                                                       |
| Checks are guessed, skipped, or reported vaguely        | The actual diff is checked with repository-approved commands                                              |
| Decisions and fixes disappear into old chats            | Reusable lessons are proposed as plain Markdown documentation and carried into future tasks once accepted |
| Agent workflows depend on one vendor                    | The core contract stays portable: CLI, Markdown, JSON, and a command adapter                              |

New chats do not require another `init`. Ordinary questions need no Noxroot task. Noxroot stays in
the background until code-changing work needs it.

<p align="center">
  <img src="docs/assets/noxroot-workflow.svg" alt="Noxroot prepares focused context, supports your coding agent, verifies the change, and keeps useful project knowledge" width="900">
</p>

This loop is Noxroot's orchestration. It prepares the task, gives your chosen coding agent focused
repository context, runs the relevant verification, and proposes any reusable learning. Noxroot does
not replace your coding agent or run a permanent agent team.

## Memory that compounds

Project memory is the versioned repository knowledge future agents should reuse: architecture,
conventions, decisions, procedures, and validated lessons. It is stored as ordinary Markdown, not
model memory or chat history.

Noxroot starts with the documentation and source already in the repository. Its knowledge index
routes agents to relevant material instead of copying it into a parallel wiki. Noxroot keeps useful
knowledge. Validated lessons keep project documentation current; when no reusable lesson exists,
nothing is added.

Because project knowledge is plain Markdown, you can inspect it in GitHub, your editor, or
optionally Obsidian. Raw prompts, application sessions, credentials, and user data do not become
project memory.

## Verification that matches the change

During setup, Noxroot detects the checks the repository already knows how to run, such as linting,
type checks, tests, builds, or native evals. You approve the policy. At finish, Noxroot applies the
relevant approved checks to the changed paths. Wider or sensitive changes can also require
independent review.

Noxroot shows which files changed, which commands ran, what passed or failed, and anything it could
not verify. A missing relevant check produces `incomplete`, never `approved`. Inspect the exact plan
before it runs with `noxroot verify --plan`.

## One quiet workflow

```bash
npx noxroot init

# Later, for a code-changing task:
noxroot start "add a page where users can save favourite restaurants"
# your existing coding agent builds the change
noxroot finish
```

Run `init` once per repository, not once per chat or day. It shows a read-only diagnosis, reuses
existing documentation, and proposes a thin managed entrypoint without replacing a good `AGENTS.md`
or copying documentation into a Noxroot-only format.

Before setup, preview labels each capability `create`, `reuse`, `conflict`, or `not-assessed`.
Noxroot creates only a confirmed gap. Existing project systems are reused, an overlapping
repository-development coordinator stops initialization, and missing evidence leaves that part of
the repository unchanged.

For code-changing work, compatible agents are instructed to run `start` before editing and `finish`
when the change is ready to check. Questions, explanations, reviews, and other read-only work do not
create tasks. If a new conversation starts the same task in the same repository, branch, and
worktree, `start` reuses the active baseline instead of creating a duplicate. `finish` infers one
applicable active task; genuine ambiguity requires an explicit task id. Native instruction discovery
still varies by coding tool, so the commands remain available for manual use.

### What setup can add

| Surface                           | Actual path or command                                                                                      | Purpose                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Agent entrypoint and config       | `AGENTS.md`, `.noxroot/config.yml`                                                                          | Connect compatible agents to the project workflow                          |
| Project-memory index              | `.noxroot/knowledge/INDEX.md`                                                                               | Route agents to relevant existing documentation                            |
| Task-context routes               | `.noxroot/routes.yml`                                                                                       | Select relevant files, rules, tests, decisions, and skills                 |
| Verification policy and skill     | `.noxroot/verification.yml`, `.noxroot/skills/verify-change/SKILL.md`                                       | Define approved checks and the procedure for checking a change             |
| Review skills                     | `.noxroot/skills/independent-review/SKILL.md`, `.noxroot/skills/product-ux-review/SKILL.md` when applicable | Provide fresh review procedures when the change requires them              |
| Learning procedure after finish   | `noxroot finish`, then `noxroot learn`                                                                      | Propose a small knowledge update when something reusable was validated     |
| Local task state created by start | `.git/noxroot/runs/*.json` in a standard checkout                                                           | Store baselines and results without treating them as project documentation |

Only missing capabilities are proposed. A mature repository may need only a small entrypoint and
configuration, or no setup changes at all.

`SKILL.md` files are portable, on-demand instructions. The generated verification skill tells an
agent how to check a change; the independent-review and optional product/UX skills describe their
reviews. Context loading comes from `AGENTS.md`, the knowledge index, and context routes, not a
generated context skill. Learning comes from `finish` and `learn`, not a generated learning skill.

Skills do not prove that code works. The actual tests, type checks, builds, evals, and review
results do. An incomplete result can be handed off locally, but it cannot become approved or qualify
for a future automatic merge. Noxroot does not push, merge, publish, or deploy.

## See what the agent gets

This example is produced from Noxroot's own repository and locked to the documentation tests:

```text
$ noxroot context "improve reviewer decision safety"

Selected 6 of 111 repository files · ~3,230 tokens
Likely owner: src/adapters/agents.ts
Likely tests: tests/agent-review.test.ts
Approved checks: format-check, lint, typecheck, test, build
Deliberately excluded: 105 unrelated files
```

Selection is advisory and explainable. It is not permission to edit a file, and a request such as
"do not deploy" stays an exclusion instead of activating deployment work.

A normal completion is intentionally compact:

```text
Changed
  3 navigation files

Checked
  TypeScript       passed
  Navigation tests passed

Review
  Not required for this bounded change

Learning
  No reusable project-knowledge candidate

Next
  Review the resulting change.
```

This transcript illustrates the stable information hierarchy; repository-specific commands and
counts come from the recorded run rather than fixed example data.

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
NOXROOT PREVIEW
Detected: Node.js project, TypeScript (npm)
Approved check candidates found: lint, typecheck, test, build
Initialization allowed: yes
Capabilities:
- Project knowledge: create
- Task routes: create
- Verification: create
- Verification skill: create
- Task orchestration: create
- Product and UX guidance: not-assessed; missing evidence: No user-facing product surface was detected.
Proposed (7): create 7
Unknown: Continuous integration
Trust: files changed 0; repository commands 0; agent calls 0; network requests 0.

No repository files changed. No project command, agent, or network request ran.
Next: noxroot preview --diff
```

Use `preview --diff` to inspect every proposed setup patch. The intended beta entry point is
`npx noxroot@latest preview`.

## Portable by design

The universal Noxroot interface is the CLI plus generated Markdown and JSON. Any coding agent that
can run a command or read a task package can use that foundation. The optional generic adapter
accepts an explicit executable and literal argument array; it does not guess vendor flags or use
shell interpolation.

Native instruction discovery varies by client. Some tools read `AGENTS.md`, others use their own
files, and some require manual invocation. Noxroot supports those layers without claiming equal
native integration with every coding tool.

Application-agent frameworks are detected project architectures, not Noxroot competitors or required
dependencies. Their native tests and evals can be approved repository checks, but the MVP does not
install or control Agno, PydanticAI, Google ADK, LangGraph, or another application runtime. Noxroot
project knowledge remains strictly separate from application runtime sessions, state, memory, and
user data.

JavaScript package evidence supports npm, pnpm, Yarn, and Bun. Explicit verification arrays support
Python, Go, Rust, and other stacks. CI covers Windows, macOS, and Linux.

## Inspect the details when you need them

`preview --diff` shows proposed writes. `context` explains file selection. `verify --plan` shows
approved commands without running them. `verify --changed` runs applicable checks. `run --dry-run`
shows a connected execution plan. `doctor` explains configuration problems. `learn --task ID` shows
confirmable durable proposals. Data commands support `--json`, with progress and diagnostics on
standard error.

Read the [command reference](docs/commands.md), [configuration](docs/configuration.md),
[architecture](docs/architecture.md), [adapter protocol](docs/adapters.md), and
[security boundaries](docs/security.md).

Noxroot is an experimental v0.1 MVP. Apache-2.0; see [CONTRIBUTING.md](CONTRIBUTING.md),
[SECURITY.md](SECURITY.md), and [LICENSE](LICENSE).
