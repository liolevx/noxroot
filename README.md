<p align="center">
  <img src="docs/assets/noxroot-wordmark.svg" alt="NOXROOT" width="100%">
</p>

# Noxroot

**Project memory and orchestration for the coding agent you already use.**

Your coding agent changes. Your project memory should not.

Noxroot is a local, open-source layer that prepares an agent before it codes, checks the result
afterward, and carries useful project knowledge into the next task. It works with your existing
agent and repository. It does not provide a model, replace Git, or take ownership of your project.

## What Noxroot changes

| Without Noxroot                                         | With Noxroot                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Each agent session rediscovers the repository           | Every task starts from the same durable project memory                       |
| Too much code is loaded or the important file is missed | The agent gets a small, explainable context package                          |
| Checks are guessed, skipped, or reported vaguely        | The actual diff is checked with repository-approved commands                 |
| Decisions and fixes disappear into old chats            | Useful lessons are proposed as plain Markdown and carried forward            |
| Agent workflows depend on one vendor                    | The core contract stays portable: CLI, Markdown, JSON, and a command adapter |

Set it up once. After that, compatible coding agents discover Noxroot through the repository's
native instruction file and use it around normal work. You keep asking for changes in ordinary
language; Noxroot stays in the background unless it finds a failure, an incomplete check, or a
decision that genuinely needs you.

![Noxroot prepares a coding agent with project memory and context, then checks the result and preserves useful knowledge](docs/assets/noxroot-workflow.svg)

## Memory that compounds

Noxroot builds **project memory**, not chat memory. It starts with the truth already in your
repository: `AGENTS.md`, README files, architecture notes, security rules, tests, and source code.
Its knowledge index routes an agent to the few documents relevant to the current task instead of
turning every session into another tour of the codebase.

After a change, Noxroot asks whether the project learned anything durable: a confirmed constraint, a
recurring verification gap, an architectural decision, or a procedure future agents should know.
When it finds something useful, it proposes the smallest update for review. When it finds nothing,
it writes nothing. It does not create a diary entry for every task or call another model merely to
invent a lesson.

Accepted knowledge remains plain, versioned Markdown. You can read and edit it in GitHub, VS Code,
or Obsidian; there is no proprietary memory database to export later. Raw prompts, hidden reasoning,
application sessions, credentials, and customer data do not become project knowledge.

That loop is the point: each useful iteration leaves the repository a little easier for the next
agent to understand, without producing a second wiki you have to maintain.

## Verification that matches the change

During setup, Noxroot detects the checks your repository already knows how to run, such as linting,
type checks, tests, builds, or native evals. You approve the policy. Noxroot does not invent
commands during a task and silently trust them.

At finish, Noxroot looks at the changed paths and runs the applicable approved checks. A small
documentation edit should stay small. A user-facing, security-sensitive, or unusually broad change
can trigger wider verification and independent review. You can inspect the exact plan before
anything runs with `noxroot verify --plan`.

The result is evidence, not a confidence performance: `approved`, `completed` with stated limits, or
`incomplete`. If a relevant check is missing or unavailable, Noxroot says so and never upgrades the
gap into approval.

## One quiet workflow

```bash
npx noxroot init

# Later, normally invoked by a compatible coding agent:
noxroot start "add a page where users can save favourite restaurants"
# your existing coding agent builds the change
noxroot finish
```

`init` is the one explicit setup step. It first shows a read-only diagnosis, reuses existing
documentation, and proposes a thin managed entrypoint. It never silently replaces a good `AGENTS.md`
or copies your documentation into a Noxroot-only format.

`start` records a clean committed baseline, interprets the requested outcome and exclusions, and
builds a bounded task package: relevant instructions, likely source and tests, known decisions, and
approved checks. In manual mode it invokes no model. A generic command adapter is available when you
explicitly configure a connected workflow.

`finish` inspects the real Git diff, runs the applicable approved checks, requests independent
review only when the risk justifies it, and looks for durable project learning. It reports a short
outcome with evidence and one next action. Routine work does not gain a mandatory review ceremony.

An unavailable relevant check produces `incomplete`, never `approved`. An incomplete result can be
handed off locally, but it cannot qualify for a future automatic merge. Noxroot itself does not
push, merge, publish, or deploy.

## See what the agent gets

This example is produced from Noxroot's own repository and locked to the documentation tests:

```text
$ noxroot context "improve reviewer decision safety"

Selected 6 of 109 repository files · ~3,230 tokens
Likely owner: src/adapters/agents.ts
Likely tests: tests/agent-review.test.ts
Approved checks: format-check, lint, typecheck, test, build
Deliberately excluded: 103 unrelated files
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
