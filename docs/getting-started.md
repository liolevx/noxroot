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

## 2. Confirm setup once

```bash
npx noxroot@latest init
```

Review the patches and approve only what belongs in this repository. Existing documentation stays in
place. Compatible agent instructions receive a pinned Noxroot command.

Review and commit the accepted setup changes before the first code-changing task. `start` requires a
clean committed Git baseline. Keep unrelated edits separate; do not discard them to make the working
tree clean.

If another coordinator owns development work, Noxroot can offer companion setup for context and
verification. It does not take over that coordinator's lifecycle, reviews, or learning.

## 3. Ask your agent for a real change

Choose a small feature, fix, or refactor you already need. Describe it normally, including anything
the agent must not change. You do not need a Noxroot-specific prompt.

In full mode, compatible agents are instructed to:

1. Run `start` before editing to record a baseline and receive the task brief.
2. Inspect the relevant files and project rules, then make the change.
3. Run `finish` to check the actual diff and report remaining gaps or required review.

Noxroot does not install native client hooks. Instructions guide agents; they cannot guarantee
compliance. For your first task, check the agent's command history for `start` and `finish`. If they
are missing, ask it to follow the repository instructions. See the [command reference](commands.md)
for manual use.

## 4. Check the result

The handoff should name the changed files, commands that ran, failures, and anything unverified.
Passing checks do not satisfy a required review. A task with incomplete verification is not
approved.

Useful lessons can be proposed for documentation after the task. Review those proposals before
applying them. No learning candidate is a valid outcome; every change does not need another
document.

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

Use the pinned version from your repository instructions. For the first release:

```bash
npx --yes noxroot@0.1.0 doctor
npx --yes noxroot@0.1.0 status
```

`doctor` checks configuration; it does not prove your agent follows instructions. `status` shows
active tasks and next actions. If task-state writes are blocked, stop before editing and approve
only the required access. Do not disable the sandbox. If several tasks match, select the intended
task instead of guessing.

For upgrades, review the [sync procedure](commands.md#init-and-sync). For Noxroot's own source
checkout, use the [development instructions](development.md).
