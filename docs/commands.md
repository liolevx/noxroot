# Command reference

## Global behavior

`noxroot --help`, `noxroot <command> --help`, and `noxroot --version` are stable discovery surfaces.
`--root <path>` selects a repository. `--json` writes one machine-readable JSON value to standard
output; diagnostics remain on standard error. `--no-color` and `NO_COLOR` disable color (current
output is plain by default).

Exit codes:

| Code | Meaning                                           |
| ---- | ------------------------------------------------- |
| 0    | Requested operation completed                     |
| 2    | Usage, configuration, or validation error         |
| 3    | Required confirmation was refused or unavailable  |
| 4    | Verification failed, timed out, or is incomplete  |
| 5    | Connected agent or required review did not finish |
| 130  | Interrupted                                       |

## `preview`

`noxroot preview [--module ID] [--diff]` is strictly read-only. Default human output is a concise
diagnosis with proposed actions and one next command; `--diff` adds every exact patch. JSON always
contains the complete repository profile, limits, module reasons, proposal contents,
discovered-but-unrun commands, proposed context estimate, and zero-side-effect counters.
`noxroot init --dry-run` is the concise aliasing experience.

Preview classifies relevant setup capabilities as `create`, `reuse`, `conflict`, or `not-assessed`.
`create` requires evidence that the capability is absent. `reuse` names the existing repository
source. A repository-development orchestration conflict refuses initialization. When evidence is
incomplete, `not-assessed` preserves that capability unchanged and explains what could not be
established.

## `init` and `sync`

`init` creates only files in the reviewed proposal. It checks every target again before writing,
writes each file through a same-directory temporary file, and rolls back files it created if the
operation fails. Existing files are never overwritten.

Explicitly referenced project knowledge, task routes, Agent Skills, and documented verification
wrappers are reused rather than copied. Noxroot does not automatically integrate with or replace an
existing repository-development coordinator.

`init --select` interactively accepts explicit module ids. `sync --dry-run` re-diagnoses an
initialized repository; add `--diff` for patches. Mutating init and sync always show exact patches
before confirmation. Sync creates or patches only hash-guarded Noxroot-owned surfaces and never
rewrites user-authored external knowledge. `--yes` is for automation that already reviewed them.

## `doctor`

Doctor validates schema versions and values, verification working directories, suspected-secret
exclusions, symlink limitations, and bounded-inspection gaps. It reports actionable findings and
does not broadly rewrite the repository.

## `context`

`context "task"` returns task interpretation, applicable areas, selected paths and reasons, likely
source/tests, constraints, approved checks, conflicts, unknowns, exclusions, bytes, and estimated
tokens. It stores paths and evidence, not copied source files.

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
knowledge.
