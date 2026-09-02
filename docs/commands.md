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

`noxroot preview [--module ID]` is strictly read-only. `noxroot init --dry-run` is an aliasing
experience, but documentation uses `preview` as the first command. Human output includes complete
proposed patches; JSON includes the repository profile, evidence, limits, module reasons, proposal
contents, discovered-but-unrun commands, context estimate, and zero-side-effect counters.

## `init` and `sync`

`init` creates only files in the reviewed proposal. It checks every target again before writing,
writes each file through a same-directory temporary file, and rolls back files it created if the
operation fails. Existing files are never overwritten.

`init --select` interactively accepts explicit module ids. `sync --dry-run` re-diagnoses an
initialized repository. Mutating sync creates missing evidence-backed files but never rewrites human
knowledge. `--yes` is for automation that has already reviewed the emitted patches.

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

`run "task" --dry-run` reads repository/configuration evidence only: it runs no Git/project command,
invokes no agent, and writes nothing. `--guided` emits the portable context and verification
package. A delegated run requires an explicitly configured command adapter, a Git commit, and
confirmation. It creates an isolated branch/worktree, snapshots verification policy before the
worker, runs deterministic checks, invokes an independent reviewer, and permits at most the
configured low repair maximum.

## `learn`

`learn --task ID` reads bounded local run evidence and proposes only supported, non-duplicate
consolidation. A valid answer is `No durable learning identified`. `--apply` still requires
confirmation (or reviewed automation via `--yes`). Learning never copies agent output, task text,
runtime sessions, user data, or secrets into committed knowledge.
