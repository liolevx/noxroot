# Command reference

## Run from npm

From your repository directory, run `npx noxroot@latest preview` to inspect setup without writing
files, then `npx noxroot@latest init` when ready. Requires Node.js `>=22.12 <27` and npm.

Commands below use `noxroot` as shorthand. Without a global installation, use
`npx --yes noxroot@0.1.0` in its place, or the version pinned in your repository instructions.
Compatible agents handle `start` and `finish`; you do not need to type them for each conversation.

## Global behavior

`noxroot --help`, `noxroot <command> --help`, and `noxroot --version` are stable discovery surfaces.
`--root <path>` selects a repository. `--json` writes one machine-readable JSON value to standard
output; diagnostics remain on standard error. Interactive output uses color, while piped output is
plain. `--no-color` and `NO_COLOR` disable color. `--verbose` adds detailed human-readable evidence
without changing JSON.

Exit codes:

| Code | Meaning                                                |
| ---- | ------------------------------------------------------ |
| 0    | Requested operation completed                          |
| 2    | Usage, configuration, or validation error              |
| 3    | Required confirmation or task-state access unavailable |
| 4    | Verification failed, timed out, or is incomplete       |
| 5    | Connected agent or required review did not finish      |
| 130  | Interrupted                                            |

## `preview`

`noxroot preview [--module ID] [--diff]` is strictly read-only. Default human output is a concise
diagnosis with proposed actions and one next command; `--diff` adds every exact patch. JSON always
contains the complete repository profile, limits, module reasons, proposal contents,
discovered-but-unrun commands, proposed context estimate, and zero-side-effect counters.
`noxroot init --dry-run` is the concise aliasing experience.

Preview classifies relevant setup capabilities as `create`, `reuse`, `adjacent`, `conflict`, or
`not-assessed`. `create` requires evidence that the capability is absent. `reuse` names the existing
repository source. `adjacent` identifies a compatible capability with a separate responsibility,
such as a cross-session work ledger. A repository-development orchestration conflict disables
Noxroot's lifecycle and learning capabilities while permitting non-overlapping context and
verification setup. When evidence is incomplete, `not-assessed` preserves that capability unchanged
and explains what could not be established. A repository made of independent examples must be scoped
to one contained project with `--root` before initialization.

## `init` and `sync`

`init` applies only reviewed file creations and managed patches. It checks every target before
writing, guards patches with the reviewed content hash, and writes through same-directory temporary
files. On failure it attempts to restore patched files and remove newly created files. Unmanaged
content is preserved; setup is not a transaction against concurrent filesystem changes.

Explicitly referenced project knowledge, task routes, Agent Skills, and documented verification
wrappers are reused rather than copied. Noxroot does not integrate with or replace an existing
repository-development coordinator. In companion mode, `start`, `run`, `finish`, and `learn` refuse
instead of creating a second lifecycle.

Generated instructions use a version-pinned `npx --yes noxroot@<version>` invocation. This needs no
global or project installation; npm retrieves the package through its normal cache. Running sync
with a newer Noxroot release is the explicit upgrade path for the managed instruction block.

`init --select` interactively accepts explicit module ids. `sync --dry-run` re-diagnoses an
initialized repository; add `--diff` for patches. Sync reports the repository pin, running CLI
version, and managed change count before the proposal. Mutating init and sync always show exact
patches before confirmation. Sync creates or patches only hash-guarded Noxroot-owned surfaces and
never rewrites user-authored external knowledge. `--yes` is for automation that already reviewed
them.

Use `npx noxroot@latest sync --dry-run --diff` to inspect a newer release, then
`npx noxroot@latest sync` to apply only the reviewed managed changes. There is no separate upgrade
state or background update.

## `doctor`

Doctor validates schema versions and values, verification working directories, suspected-secret
exclusions, symlink limitations, and bounded-inspection gaps. It reports actionable findings and
does not broadly rewrite the repository.

## `context`

`context "task"` shows the outcome, a bounded selection of paths, relevant files and related tests,
approved checks with their working directories, an exclusion count, and estimated tokens. Exclusions
and conflicts remain visible. `--verbose` adds every selected path, selection reasons, individual
exclusions, unknowns, and byte counts. JSON retains the complete bounded context package.

The human headings are `Relevant files`, `Related tests`, and `Checks to run`. Selection is
advisory; listed checks have not run. JSON keeps the existing `likelyOwningSource`, `likelyTests`,
and `requiredVerification` fields.

Large source and test files can be selected as up to three line ranges rather than whole files.
Human output labels these as partial. JSON adds `lineRanges` (one-based, inclusive) and
`sourceBytes`; `bytes` counts only the selected ranges. These are reading hints, not embedded code
or complete functions. Inspect surrounding code and refresh context after edits move the lines.
Inspection remains capped at 96,000 bytes per file and 1,000,000 bytes across candidates. Missing
owners, partial files, and inspection limits prevent high confidence.

Fresh setup includes root-level source extensions in its routes. Existing route files are not
rewritten by `init` or `sync`. If context reports excluded source files, review the includes in
`.noxroot/routes.yml` before widening scope; updating the CLI alone does not change those
boundaries.

Routine `start`, continuation, and `finish` output separates the result from supporting evidence.
The short finish view still shows failures, verification gaps, pending review, and a path to the
full local record. Passing tests alone never turn a pending review into approval.

### Local task-state access

New Git repositories use `.noxroot/local/runs/`, inside the writable worktree rather than Git's
metadata. Its managed `.gitignore` contains `*`; never force-add task records to Git. Inspection and
read-only conversation create no state. Retention rules are unchanged.

Existing `.git/noxroot` state remains authoritative. Noxroot does not move active tasks during an
upgrade. If this legacy directory is sandbox-protected, approve access only to the reported state
directory, or run the lifecycle command yourself in a trusted terminal. Do not disable the sandbox
or create another store. A blocked start means stop before editing; a blocked finish means the task
is not complete. Sync updates the managed instructions with these rules after you review its diff.

## `status`

`status` is a read-only answer to "where is this repository task?" It reports the current branch,
working-tree state, active Noxroot tasks, changed paths since each baseline, whether verification
matches the current diff, and the next applicable action. It does not invoke an agent or restore a
chat session.

Before resuming edits, repeat `start` with the active task's text. `status` does not check whether
task state is writable and is not a substitute for `start`.

## `verify`

`verify --plan` displays the confirmed policy without running it. `verify --changed` reads Git
status and routes changed paths to applicable commands. `verify --task ID` labels the output for a
recorded task. Commands run directly, sequentially, with working-directory validation,
timeout/cancellation, a minimal environment, and bounded output. Execution stops after the first
failure.

## `start` and `run`

`start "task"` is the plain-language guided entry point. It records a clean Git baseline, structured
outcomes and exclusions, bounded context, and the trusted verification policy without invoking a
model. Repeating the same task in the same repository, branch, and worktree reuses the active record
and baseline instead of creating a duplicate, including when the worktree now contains the task's
changes. Its continuation brief derives changed paths from the baseline, compares any recorded
verification with the current diff, and reports the next applicable action. Verification is shown as
not run, current and passed, current but incomplete or failed, or stale after a later edit. A
different task creates a separate record. Generated repository instructions tell compatible agents
to use this lifecycle only for code-changing work; read-only conversation does not start a task.

`run "task" --dry-run` exposes effective autonomy, calls, scopes, checks, and prohibitions without a
Git/project command, agent, or write. Level 2 permits an explicitly configured worker in an isolated
branch/worktree. Before that worktree exists, preflight checks the executable, literal arguments,
repository write access, Git baseline, approved check executables, and only an explicitly configured
health command. Level 3 permits review and bounded repair. Merge and delivery remain disabled.

## `finish`

`finish [--task ID] [--review-file path]` closes a guided task. The id is inferred when exactly one
eligible task is active; multiple tasks require an explicit id. Finish validates repository identity
and the policy snapshot, computes the actual diff, and runs matching approved checks. Routine
checked changes become `completed` without a reviewer. User-facing, security-sensitive, and
unusually broad diffs produce a review package and may become `review-pending`. Only a schema-valid
reviewer can produce `approved`. No matching or available check becomes `incomplete`: local handoff
can continue, but approval cannot. Finish also reports a deterministic documentation/learning
assessment without a new model call. When no deterministic documentation signal exists,
documentation is reported as `not-assessed`; an empty deterministic learning assessment is reported
as `no-candidate`, not as proof that no documentation could help.

## `learn`

`learn --task ID` accepts structured reviewer candidates of kind `knowledge`, `decision`,
`procedure`, `verification`, or `none`. A verification gap is reported by `finish`, but does not
become project knowledge merely because it occurred once. Proposals show evidence, expected value,
duplication/conflict results, content, and whether an executable guardrail is better. `--apply`
requires confirmation; the first learnings file and index link are written in the same operation.
Raw prose, task text, sessions, user data, secrets, and external human docs are not converted into
knowledge. New entries carry a confirmation date and source task id. Noxroot refuses another entry
when the destination would exceed `context.documentWarningBytes`; existing knowledge must then be
consolidated or superseded deliberately.
