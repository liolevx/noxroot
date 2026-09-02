# Command reference

## Global behavior

`noxroot --help`, `noxroot <command> --help`, and `noxroot --version` are stable discovery surfaces.
`--root <path>` selects a repository. `--json` writes one machine-readable JSON value to standard
output; diagnostics remain on standard error. `--no-color` and `NO_COLOR` disable color (current
output is plain by default).

Exit codes:

| Code | Meaning                                          |
| ---- | ------------------------------------------------ |
| 0    | Requested operation completed                    |
| 2    | Usage, configuration, or validation error        |
| 3    | Required confirmation was refused or unavailable |
| 4    | Approved verification failed or timed out        |
| 5    | Agent/reviewer flow did not finish approved      |
| 130  | Interrupted                                      |

## `preview`

`noxroot preview [--module ID] [--diff]` is strictly read-only. Default human output is a concise
diagnosis with proposed actions and one next command; `--diff` adds every exact patch. JSON always
contains the complete repository profile, limits, module reasons, proposal contents,
discovered-but-unrun commands, proposed context estimate, and zero-side-effect counters.
`noxroot init --dry-run` is the concise aliasing experience.

## `init` and `sync`

`init` creates only files in the reviewed proposal. It checks every target again before writing,
writes each file through a same-directory temporary file, and rolls back files it created if the
operation fails. Existing files are never overwritten.

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

## `run`

`run "task" --dry-run` prints effective autonomy, calls, scopes, checks, and prohibitions without a
Git/project command, agent, or write. At implementation level 1, `--guided` records a clean Git
baseline, context, and trusted policy for an external agent. Level 2 permits a configured worker in
an isolated branch/worktree. Level 3 permits reviewer/repair execution. Merge and delivery remain
disabled. Policy is captured before the worker and actual changed paths select affected checks.

## `finish`

`finish --task ID [--review-file path]` closes a guided task. It validates repository identity and
the recorded policy hash, computes the diff from the baseline (including new files), runs matching
approved checks, and creates a portable reviewer package. Without an authorized command reviewer or
a strict repository-relative review JSON file, successful checks produce `review-pending`, not
approval. Zero matching checks, unavailable tools, and invalid reviewer output block completion.

## `learn`

`learn --task ID` accepts only deterministic verification evidence and structured reviewer
candidates of kind `knowledge`, `decision`, `procedure`, `verification`, or `none`. Proposals show
evidence, expected value, duplication/conflict results, content, and whether an executable guardrail
is better. `--apply` requires confirmation; the first learnings file and index link are written in
the same operation. Raw prose, task text, sessions, user data, secrets, and external human docs are
not converted into knowledge.
