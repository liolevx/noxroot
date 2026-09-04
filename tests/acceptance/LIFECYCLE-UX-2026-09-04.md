# Lifecycle and terminal acceptance

September 4, 2026. Baseline: `c32241b`. Product code validated through `9a18ac6`. No runtime
dependencies, external-repository changes, client hooks, publication, or deployment.

## What changed

1. New Git repositories keep ignored task records in `.noxroot/local/runs/`, outside protected Git
   metadata. Read-only inspection creates nothing. Existing `.git/noxroot` records remain
   authoritative; competing stores are refused. New worktrees have separate state; legacy shared
   records remain discoverable. Existing identity, branch, baseline, and retention checks still
   apply.
2. Continuation and finish check state write access. A denied write explains the required access.
   Generated instructions tell agents to stop after a failed start and not claim a failed finish as
   complete. State reads, writes, doctor inspection, and retention refuse linked run directories.
3. Routine start, continuation, context, and finish output is shorter. Context avoids repeated
   paths; commands retain their working directories. Failures, unavailable checks, and blocked or
   pending reviews stay visible. Full evidence remains in the local record, verbose view, and
   structured JSON. Mutating setup still shows exact patches before confirmation. Verification
   failures return exit 4.
4. Generated instructions recommend `status` before raw task records. This guides compatible agents;
   it does not control their narration or guarantee identical behavior across clients.

## Actual agent journey

Two packed installations were exercised with three fresh Codex sessions each, using an existing
ChatGPT login, `--ephemeral --ignore-user-config --sandbox workspace-write`, and approval policy
`never`. No API key, permission bypass, global installation, or model-based continuation logic.

The synthetic JavaScript repository contains a URL helper, native Node tests, and an existing
navigation convention. It is not a real Next.js application or a browser acceptance test. The
harness explicitly approved `npm test` at repository root; discovery alone did not authorize
execution.

| Check                       | Result in both runs                                    |
| --------------------------- | ------------------------------------------------------ |
| Preview                     | No file changes                                        |
| Repeated initialization     | Byte-identical project files                           |
| Ordinary question           | No task and no edits                                   |
| First code-changing session | One task; failing regression reproduced                |
| Fresh-session continuation  | Same task ID and baseline, no duplicate                |
| Finish without `--task`     | One applicable task inferred; persisted as `completed` |
| Native verification         | Two tests passed; `git diff --check` passed            |
| Documentation               | Existing convention reused; zero documentation changes |

The implementation changed one return expression from `url.pathname` to `url.pathname + url.search`
and added one regression test. No review was required by the current applicability rules. The final
live task was `20260904-c8d17cd6`, baseline `ed4804101e879df08656294babbd3de597bae2d3`.

The first fresh agent read raw task JSON. After the guidance adjustment, the repeat used `status`
before continuing and did not dump the task record. Agents still performed their own source reads,
test commands, and narration. The harness displays agent summaries separately from installation; it
is not a claim that the complete agent terminal contains only Noxroot's summary lines.

The live runs preceded the final linked-retention and blocked-review hardening. Final product code
was then repacked and exercised through deterministic start/fail/continue/finish on both platforms.

## Output and validation

- Observed Noxroot output: start 7 lines, continuation 6, finish 12 including three progress lines.
  Counts exclude the trailing empty split element. Long paths may wrap in narrower terminals.
- Same TypeScript fixture and request: context decreased from 25 to 19 logical lines, a 24%
  reduction.
- Output regressions cover 80/120-column options, no-color/piped output, JSON, failed checks,
  unavailable commands, pending reviews, invalid reviewer responses, and verbose evidence.
- Complete `npm run check` passed on Windows and WSL/Linux: formatting, lint, types, 196 passing
  tests and two platform-specific skips on each, build, compiled read-only safety, and packed
  install. There are 198 tests total, 14 more than the baseline. The skipped tests differ by
  platform.
- Packed smoke now tests a failing check, persisted failure, same-task continuation, automatic
  finish inference, one record, unchanged baseline, and ignored runtime state.
- Existing 600-record retention and 30-task cross-stack context regressions passed. These are
  synthetic regression tests, not 600 agent sessions or 30 newly cloned repositories.
- Linux dependency installation reported zero audit vulnerabilities. No macOS or Claude Code live
  run was performed in this slice.

## Size and documentation

Product source: 280 added / 62 removed lines, net +218 across seven files. Tests and the opt-in
acceptance driver account for most additional repository lines. No dependencies were added.

Packed size: 120,983 to 124,049 bytes, +3,066 bytes (about 2.5%). Unpacked size: 387,801 to 399,204
bytes. README: local-state table entry updated plus one legacy-access paragraph. Whitespace word
count: 1,436 to 1,461, net +25. Intro, tagline, logo, and screenshot are unchanged. Architecture and
command references explain the new location, legacy behavior, failure contract, and concise output.

## Limits and handoff

Legacy repositories can still require narrowly scoped approval to write `.git/noxroot`. This slice
does not migrate active records or weaken a sandbox. The reliable default is demonstrated for new
setups, not a universal migration claim. Read-only client policies still require user approval for
any code-changing work.

Live recovery evidence is retained under `/tmp/noxroot-lifecycle-zaBA7M` and
`/tmp/noxroot-lifecycle-muMmu5`. Each synthetic repository has two uncommitted source/test changes;
these must not be silently deleted. Installed packages, caches, and disposable build copies are
removed separately. The earlier `/tmp/noxroot-live-SND14p` recovery evidence was not changed.

Working repository: `C:/Users/lione/Documents/ChatGPT/noxroot`. Branch:
`agent/sandbox-lifecycle-quiet-output`. No additional implementation worktrees or files in
workspace-parent directories. Push, merge, npm publication, and fresh independent review remain
separate release actions.
