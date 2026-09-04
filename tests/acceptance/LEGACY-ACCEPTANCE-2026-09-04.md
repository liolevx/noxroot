# Legacy workflow acceptance

Baseline: `9602dcd`. This pass adds targeted legacy workflows and a fresh independent review, not
another broad repository survey. No upstream commits, npm publication, or deployment.

## Findings and corrections

The independent reviewer found that short finish output could display an earlier reviewer approval
after a newer diff failed verification or awaited fresh review. Five regressions failed before the
fix. Eight added cases now cover historical decisions and current approval, rejection, and blocked
review. History remains available, but the short view reports the current completion attempt.

A real Codex continuation initially skipped `start` after reading `status`, edited a test, then
correctly reported that finish was blocked by protected legacy state. This was a failed acceptance
run, not a pass. Generated instructions and human status now explicitly require repeating `start`
before resumed edits. Two existing tests were extended and failed before the correction.

Review also caught that status showed a shortened outcome rather than the full task text. This could
drop exclusions and prevent matching continuation. Status now shows the original text. A regression
extracts the displayed `change the value; do not deploy` task and resumes the same record on a dirty
tree. It failed before the correction.

The reviewer approved the corrections after 54 targeted tests, typecheck, and diff checks. The
strict response is retained in [legacy-review-2026-09-04.json](legacy-review-2026-09-04.json).

## Three operator-driven workflows

Both old and current CLIs were packed and installed offline with locally packed dependencies and
installation scripts disabled. The old CLI was built from actual commit `c32241b`, not simulated by
moving a current task record. Both packages still identify as unpublished `0.1.0`; this is a source
upgrade rehearsal, not an npm registry version upgrade.

| Repository                                                   | Change and verification                                                                       | Result                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Synthetic legacy CommonJS project                            | Preserve internal spaces in normalization; `npm test`, cwd `.`                                | Old task survived sync, denied access, failure, continuation, and inferred finish |
| Underscore 1.8.3, `e4743ab712b8ab42ad4ccb48b155034d02394e4d` | Add a groupBy ordering regression; `node noxroot-acceptance.cjs`, cwd `test`                  | Failure surfaced, same task resumed, corrected regression completed               |
| Bottle 0.12.25, `40aec5d4cca6ff4fbd73f4080554580fe4f5c212`   | Add leading-zero integer route regression; `python3 -B -m unittest test.test_router`, cwd `.` | Existing 32 tests passed; added inherited regression produced 34 passing tests    |

Failures were deliberately incorrect test expectations, not discovered upstream defects. Underscore
used focused Node assertions against the real library, not its obsolete QUnit, lint, or browser
toolchain. Bottle exercised its router suite, not the whole framework. These are real CLI and native
test processes, but operator-driven test additions rather than autonomous feature implementations.

Each workflow preserved one task ID and baseline, reported stale verification after another edit,
inferred finish without an ID, and recorded a completed result. No model calls were needed for the
CLI lifecycle. Checks were explicitly approved by the operator; automatic discovery returned none
for these cases and is not credited with finding them.

## Upgrade and ownership evidence

- Preview was read-only; repeated initialization was unchanged in all three cases.
- Legacy sync proposed and changed only the managed block in `AGENTS.md`. It added four lines;
  surrounding team instructions, `CLAUDE.md`, architecture documentation, and task record stayed
  unchanged. A second sync proposed no changes. The later continuation clarification extends one
  existing managed line, without adding another file.
- With legacy `runs/` made read-only, status still worked; start and finish exited 3. Neither task
  record nor repository content changed, and no second store was created.
- Restoring access allowed continuation of the original task. This is manual permission recovery,
  not an automatic state migration or a claim that every agent can obtain narrow write access.
- Subsequent task work added no knowledge documents or learning proposals. Documentation remained
  `not-assessed`; zero proposals is not proof that no useful lesson could exist.
- External checkouts changed only their stated regression test. Their Git revisions are unchanged.

Initial setup proposed `AGENTS.md`, config, knowledge index, routes, and independent-review skill
for each external repository. Underscore's existing `CONTRIBUTING.md` was referenced, not copied.
Neither external setup proposed a verification policy or verification skill without evidence; the
operator explicitly configured one approved command afterward.

## Context quality: weaker than lifecycle reliability

- Legacy project: seven selected files, 1,951 bytes, about 488 tokens. Included existing AGENTS,
  CLAUDE instructions, architecture, source, and regression test.
- Underscore: nine selected files, 12,835 bytes, about 3,209 tokens; confidence `insufficient`. The
  main implementation was absent. This was not a useful standalone implementation brief.
- Bottle: ten selected files, 13,599 bytes, about 3,400 tokens. The router test was selected, but
  `bottle.py` was absent and unrelated plugin tests were included. Reported `high` confidence is too
  reassuring for this example.

All remained within the default 16,000-byte budget. That proves bounded size, not relevance. Large
single-file implementations and confidence calibration remain limitations. README now states that
large files may be omitted and legacy/custom checks may require explicit configuration. No parser,
routing system, dependency, or model-based retrieval feature was added to this slice.

## Live agent denial and retest

One fresh Codex session used the user's existing ChatGPT login with `workspace-write`, approvals
disabled, and no sandbox bypass. The first attempt failed the no-edits assertion because it skipped
start. Its task record was unchanged and finish reported the restriction honestly.

After the instruction/status correction, the same scenario in a fresh fixture passed all four
assertions: start exited 3 with an actionable write-access error; no agent edits; unchanged record;
no second store. The agent stopped without running tests or claiming completion. This demonstrates
one successful instruction-following case, not guaranteed behavior from every client or future run.
The later full-task status-text correction was covered by the deterministic continuation regression.

The sandbox settings follow
[official OpenAI documentation](https://learn.chatgpt.com/docs/agent-approvals-security). No
credentials or raw agent transcripts were stored in repository knowledge. Only bounded product
command output and final summaries were retained in the isolated test directory.

## Reproduction and retained evidence

Final local validation at `3b8b20a`: full `npm run check` passed on Windows and in a clean Linux
copy. Each ran 204 tests with two platform-specific skips, formatting, lint, typecheck, build,
permission-confined preview, and installed-package smoke. The 600-record retention regression also
passed. An intermediate test-only lint failure was corrected before these final runs.

Before the CI correction below, changes since `9602dcd` covered three source files, ten added lines
and three removed. Eight tests were added and existing continuation/initialization assertions
extended. No runtime dependencies were added. The README changed from 1,461 to 1,451
whitespace-separated words, preserving its intro and existing visual assets. Final package size:
124,307 bytes, up 258 bytes from the preceding 124,049-byte candidate; unpacked size 399,858 bytes.
Reproduction scripts and reports are not shipped in the npm package.

The validated branch is pushed as [PR #9](https://github.com/liolevx/noxroot/pull/9). Its checks are
the source of truth for GitHub Windows/macOS/Linux, Node 22/24/26, and package validation. This pass
does not authorize merging or npm publication.

### Cross-platform CI follow-up

The first PR run passed Linux, Node 22/26 smoke, and package checks, but failed Windows and macOS
tests on aliased temporary-directory roots. Review confirmed a real CLI issue as well: preview/init
accepted an aliased `--root`, while lifecycle commands passed the alias to a canonical-root safety
check and failed. Merely changing the test helper would have hidden that public CLI case.

A new regression failed locally before the correction. It now exercises init, start, status,
same-task continuation, and inferred finish through a directory alias with an actual syntax check.
The task identity and ignored local store use the canonical repository. CLI options now resolve the
user-selected root once at the command boundary. Direct state-layer fixtures also use canonical
temporary paths. Nested-link and changed-root protections in `setupDestination` are unchanged.

This adds one deterministic test, taking the suite to 207 cases. Full Windows and clean Linux
validation passed after the correction: 205 passed and two platform-specific skips each. Final
package size is 124,396 bytes (347 bytes above the preceding candidate), unpacked 400,091 bytes. The
independent [alias-root review](alias-root-review-2026-09-04.json) approved the fix. GitHub checks
on the latest PR commit determine whether the Windows/macOS correction is confirmed; successful
local runs alone are not evidence of a passing CI result.

`legacy-workflows.mjs` takes an explicitly prepared `/tmp/noxroot-legacy-acceptance-*` directory
containing inspected pinned `underscore/`, `bottle/`, and built `old-source/` directories. It
installs the packed CLIs and runs the three workflows. `live-legacy-denial.mjs` takes that directory
and an optional fresh fixture name such as `live-legacy-retry`. It requires an existing Codex login
and the latest packed tarball in `current-install/`. Neither script is part of normal CI or
publishes.

The first scripts ran with the reviewed finish-output fix. The live retest used the additional
continuation guidance. Final cross-platform validation and package smoke cover the completed branch;
the three original workflows are not claimed as rerun after every wording refinement.

Scratch evidence root: `/tmp/noxroot-legacy-acceptance-4KcWWC`. Preserve dirty repositories:

- `legacy-project`: managed instruction update and normalization regression.
- `underscore`: untracked `test/noxroot-acceptance.cjs`.
- `bottle`: modified `test/test_router.py`.
- `live-legacy`: managed instruction update and agent-added regression from the failed acceptance.
- `live-legacy-retry`: managed instruction update only; no edits by the agent.

No worktrees were added to the Noxroot project and no workspace-parent artifacts were created.
Package installs, caches, tarballs, and the extracted old source were removed. The isolated Linux
validation trees were removed by the runner. The five dirty checkouts and small reports remain in
the single 4.7 MB evidence directory until their removal is reconciled with workspace policy.

Noxroot repository: `C:/Users/lione/Documents/ChatGPT/noxroot`. Branch:
`agent/sandbox-lifecycle-quiet-output`; kept for PR review, not merged.
