# Getting started

Use Noxroot in a repository you already work on, with your usual coding agent. You need Node.js
`>=22.12 <27`, npm, and a Git repository with a committed baseline for code-changing tasks. No
global Noxroot installation is required.

## 1. Preview your repository

Open a terminal in your project directory:

```bash
npx noxroot@latest preview --diff
```

Noxroot shows what it found, what it would reuse, and the exact files setup would change. Preview
does not modify the project or run its commands. npm may download the CLI first.

Check that it found your existing instructions and documentation. Look at proposed verification
commands and their working directories. Missing evidence should remain visible, not become a guessed
command. For a repository of independent examples, select one project with `--root`.

You can also try `npx noxroot@latest context "<your actual task>"` before setup. This reads the
repository without committing anything. It shows a proposed brief, not completed verification.

## 2. Confirm setup once

```bash
npx noxroot@latest init
```

Review the patches and approve only what belongs in this repository. Existing documentation stays in
place. Compatible agent instructions receive a pinned Noxroot command.

Before accepting checks, inspect the executable, arguments, working directory, and affected paths in
`.noxroot/verification.yml`. A discovered test command is not proof that its dependencies are
installed or that it covers your change. For a missing command, use your project's documented check;
do not approve a placeholder that always succeeds. `verify --plan` shows the approved plan without
running it. See [verification configuration](configuration.md).

Review and commit the accepted setup changes before the first code-changing task. `start` requires a
clean committed Git baseline. Keep unrelated edits separate; do not discard them to make the working
tree clean.

This is a **local commit**, not a push or a commitment to keep Noxroot. It separates setup from the
task's actual code diff. If you are still evaluating it, stay with preview/context or use a
disposable copy before changing your working repository.

If another coordinator owns development work, Noxroot can offer companion setup for context and
verification. It does not take over that coordinator's lifecycle, reviews, or learning.

## 3. Ask your agent for a real change

Choose a small feature, fix, or refactor you already need. Describe it normally, including anything
the agent must not change. You do not need a Noxroot-specific prompt.

In full mode, compatible agents are instructed to:

1. Run `start` before editing to record a baseline and receive the task brief.
2. Inspect the relevant files and project rules, then make the change.
3. Run `finish` to check the actual diff and report remaining gaps or required review.
4. Address failures or review findings; rerun `finish` after any further edit, including formatting.
5. Review and commit the finished change before starting the next task.

Noxroot does not install native client hooks. Instructions guide agents; they cannot guarantee
compliance. For your first task, check the agent's command history for `start` and `finish`. If they
are missing, ask it to follow the repository instructions. See the [command reference](commands.md)
for manual use.

## 4. Check the result

The handoff should name the changed files, commands that ran, failures, and anything unverified.
Passing checks do not satisfy a required review. A task with incomplete verification is not
approved.

If finish reports `review-pending`, run `noxroot review --task ID`. Give its JSON package to a fresh
coding-agent reviewer, save the strict response under `.noxroot/local/`, and pass that file back to
`finish --review-file`. Noxroot checks that the response belongs to the current unchanged diff.

Useful lessons can be proposed for documentation only after an approved review of the current
unchanged diff. Review those proposals before applying them. `Not assessed` means that review did
not happen; `no candidate` means it did and found nothing reusable. Every change does not need
another document.

An accepted lesson must also be eligible for the task's context route. Fresh setups include
`.noxroot/knowledge/**`; relevance and size limits still apply. If an older setup includes only
`.noxroot/knowledge/INDEX.md`, review `.noxroot/routes.yml` and add the lesson path or the knowledge
glob to the appropriate route. Existing routes are not widened automatically. Keep intentional
exclusions, and use `context "<your task>" --verbose` to inspect selection and exclusions.

For your first few tasks, ask:

- Did the brief surface a relevant rule or file without loading unrelated material?
- Did the checks catch a problem or provide evidence you can inspect?
- Was useful knowledge reused next time, without duplicating existing docs?

These are usefulness checks, not a requirement to keep a session journal.

## Continue later

Open the same repository, branch, and worktree and keep working with your agent. Repeating `start`
for the same active task continues its baseline. A new chat needs neither another `init` nor a task
for ordinary questions. Local task state is not chat restoration or cross-machine synchronization.

## If something looks wrong

Use the pinned version from your repository instructions. For the current release:

```bash
npx --yes noxroot@0.1.1 doctor
npx --yes noxroot@0.1.1 status
```

`doctor` checks configuration; it does not prove your agent follows instructions. `status` shows
active tasks and next actions. If task-state writes are blocked, stop before editing and approve
only the required access. Do not disable the sandbox. If several tasks match, select the intended
task instead of guessing.

**A check timed out:** read the command, working directory, time limit, and last captured output.
Confirm the project's prerequisites and environment. A sandbox-dependent failure is still a failed
check; do not disable sandboxing, delete a check, or silently increase its limit to make it green.
After resolving the cause, rerun `finish`. An operator's separate diagnostic run is not an automatic
agent pass. Captured output is byte-capped; when truncated, Noxroot keeps the tail, not the full
log.

**npm/pnpm says the release is too new:** repositories can enforce `min-release-age` or
`minimumReleaseAge`. A fresh Noxroot release can be refused just like another dependency. Keep that
policy intact and retry the same install path after its waiting period, or use an already eligible
version approved for the project. `ERR_PNPM_NO_MATURE_MATCHING_VERSION` identifies this case;
`ETARGET` alone can have other causes. Inspect the full native error before assuming an age block.
Project-local installation and `npx` resolution are different paths; neither should be used as a
workaround to evade the project's policy.

For upgrades, review the [sync procedure](commands.md#init-and-sync). For Noxroot's own source
checkout, use the [development instructions](development.md).
