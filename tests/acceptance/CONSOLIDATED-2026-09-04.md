# Noxroot adoption: consolidated evidence and priorities

## Bottom line

Noxroot has credible evidence of safe, bounded operation across varied repositories and successful
use by a real coding agent across repeated tasks. Its strongest demonstrated value is making the
task baseline, selected context, approved checks, and outcome explicit. We have not demonstrated
that it makes agents faster, generates useful long-term knowledge, or works automatically
everywhere.

**The audited corpus contains 50 distinct repositories, not 60.** The latest ten-repository workflow
pass revisited ten of the twenty published-package probes. Two controls also reused repositories.
The earlier conversational total of sixty double-counted those ten. Older unenumerated experiments
are excluded rather than used to fill the difference.

| Evidence layer                     |           Repositories | What actually happened                                                                         |
| ---------------------------------- | ---------------------: | ---------------------------------------------------------------------------------------------- |
| Pre-release packed CLI breadth     |            30 distinct | Read-only probes; 29 repeatable setups; 27 bounded lifecycle exercises without approved checks |
| Published 0.1.0 breadth            | 20 additional distinct | Preview and context only; no initialization or native tests in this lane                       |
| Published 0.1.0 repeated workflows |         10 of those 20 | Six completed three tasks each; one agent task blocked; three package installations blocked    |
| Matched controls                   |          2 of those 10 | One task each without Noxroot; both succeeded                                                  |

The latest pass therefore contains **18 completed treatment tasks, one blocked treatment session,
and two successful control sessions**. Those are 21 real Codex sessions, not 30 completed tasks.
Earlier pre-release evidence is not a rerun of all fifty against the published version.

## What works, with evidence

- **Read-only safety and bounded context:** both breadth passes preserved files and symlinks during
  preview/context, with selected context within 16,000 bytes. The twenty recent proposals were
  deterministic; their compact briefs occupied 24–29 lines before terminal wrapping.
- **Real agent invocation:** all nineteen treatment sessions called the lifecycle, including the
  blocked session, without a per-task reminder. Setup instructions were installed beforehand.
- **Repeated work:** Morgan, Requests, HTTPX, Flask, markdown-it, and Chalk each completed three
  related tasks in fresh conversations, preserving earlier changes through local commits.
- **Actual verification:** the six successful sequences ran approved native checks. Morgan also
  passed an operator-run full suite after each change. Focused checks elsewhere are not full-suite
  coverage or proof that every implementation is production-ready.
- **Honest failure states:** Starlette's in-sandbox timeout stayed failed. Earlier Kleur tests
  failed in their native loader, and Noxroot did not turn that into success. Unverified/no-change
  lifecycle exercises were not silently approved.
- **No documentation pile-up in this sample:** no Noxroot knowledge files changed during the latest
  sequences. Morgan's existing README was edited by the agent as requested, not by automatic
  learning.

The synthetic 600-record test checks retention behavior without 600 model sessions. It retained 100
records and removed 500 eligible completed records, protecting active/incomplete records. Protected
or malformed records can exceed the nominal count. Owned-Markdown byte limits and separate runtime
records constrain growth; neither constitutes semantic curation or proof of useful knowledge.

## Complete repository inventory

### Thirty pre-release breadth cases

For every row below, preview/context safety and budget checks passed. "Lifecycle" means the bounded
no-approved-command exercise, not an agent-built feature. That older harness hid some setup paths
through `.git/info/exclude`, so its lifecycle lane is not ordinary onboarding evidence.

| Repository            | Stack                    | Additional outcome                                                                   |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| sindresorhus/p-limit  | JavaScript               | Lifecycle exercised                                                                  |
| sindresorhus/p-queue  | TypeScript               | Lifecycle exercised                                                                  |
| sindresorhus/execa    | JavaScript               | Lifecycle exercised                                                                  |
| tj/commander.js       | JavaScript CLI           | Lifecycle exercised                                                                  |
| lukeed/kleur          | JavaScript terminal      | Lifecycle; separate native test failed before/after change under Node 24             |
| fastify/fastify       | JavaScript server        | Lifecycle; ignored-instruction repeat-init defect fixed before final run             |
| koajs/koa             | JavaScript server        | Lifecycle exercised                                                                  |
| reduxjs/redux         | TypeScript               | Lifecycle exercised                                                                  |
| pmndrs/zustand        | React/TypeScript         | Lifecycle exercised                                                                  |
| TanStack/query        | TypeScript monorepo      | Setup tested; lifecycle skipped because tracked setup required commit                |
| pallets/click         | Python CLI               | Lifecycle exercised                                                                  |
| pallets/itsdangerous  | Python                   | Lifecycle; separate native regression passed 298 tests after 297-test baseline       |
| pallets/jinja         | Python                   | Lifecycle exercised                                                                  |
| pydantic/pydantic     | Python/Rust              | Lifecycle exercised                                                                  |
| python-attrs/attrs    | Python                   | Lifecycle exercised                                                                  |
| pytest-dev/pluggy     | Python                   | Setup refused without writes; different root instruction sources need reconciliation |
| BurntSushi/toml       | Go                       | Lifecycle exercised                                                                  |
| go-chi/chi            | Go                       | Lifecycle exercised                                                                  |
| rs/zerolog            | Go                       | Lifecycle exercised                                                                  |
| stretchr/testify      | Go                       | Lifecycle exercised                                                                  |
| junegunn/fzf          | Go terminal              | Lifecycle exercised                                                                  |
| serde-rs/json         | Rust                     | Lifecycle exercised                                                                  |
| clap-rs/clap          | Rust workspace           | Lifecycle exercised                                                                  |
| sharkdp/bat           | Rust                     | Lifecycle exercised                                                                  |
| tokio-rs/axum         | Rust workspace           | Lifecycle exercised                                                                  |
| ruby/rake             | Ruby                     | Lifecycle exercised; native workflow not established                                 |
| sinatra/sinatra       | Ruby                     | Lifecycle exercised; native workflow not established                                 |
| slimphp/Slim          | PHP                      | Lifecycle exercised; native workflow not established                                 |
| dorny/paths-filter    | TypeScript GitHub Action | Lifecycle exercised                                                                  |
| neovim/nvim-lspconfig | Lua                      | Setup tested; lifecycle skipped because tracked setup required commit                |

### Twenty published-package cases, including the ten deeper attempts

All twenty passed read-only preview/context invariants; all proposed that initialization could
proceed. Nineteen briefs had partial confidence, libsodium insufficient confidence. Initialization
was not executed in the breadth lane. Workflow outcomes below come from the separate deeper lane.

| Repository               | Stack                        | Deeper evidence or significant gap                                                            |
| ------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------- |
| expressjs/express        | JavaScript server            | Project-local npm install rejected package younger than seven days                            |
| pallets/flask            | Python web                   | Three completed tasks; focused tests 20 → 22 → 26                                             |
| encode/starlette         | Python ASGI                  | One session timed out; same unchanged check passed outside sandbox; no two later tasks        |
| encode/httpx             | Python HTTP client           | Three completed tasks; focused tests 15 → 16 → 17                                             |
| psf/requests             | Legacy Python client         | Three completed tasks; focused tests 25 → 26 → 30; one successful control                     |
| django/django            | Large Python framework       | Preview/context only                                                                          |
| sveltejs/kit             | Svelte monorepo              | Client scroll-restoration implementation missed; package-manager ambiguity needs review       |
| withastro/astro          | Astro monorepo               | Existing docs/skills detected; local pnpm resolution rejected package younger than three days |
| nuxt/nuxt                | Vue monorepo                 | Local pnpm resolution rejected package younger than one day                                   |
| honojs/hono              | TypeScript server            | Preview/context only; central implementation ranking needs review                             |
| expressjs/morgan         | Legacy JavaScript middleware | Three completed feature tasks; focused tests 3 → 7 → 10; full suite passed; control succeeded |
| isaacs/node-lru-cache    | TypeScript library           | Preview/context only                                                                          |
| markdown-it/markdown-it  | Parser                       | Three completed tasks; ruler tests 9 → 10 → 12                                                |
| chalk/chalk              | JavaScript terminal          | Three completed regression-test tasks; AVA checks passed                                      |
| gin-gonic/gin            | Go server                    | Preview/context only                                                                          |
| jmoiron/sqlx             | Go database library          | Preview/context only                                                                          |
| rust-lang/regex          | Rust workspace               | Preview/context only                                                                          |
| jqlang/jq                | C CLI                        | Selected documentation tooling instead of JSON parser implementation; no check candidates     |
| jedisct1/libsodium       | C library                    | No source owner or check candidates for public version API                                    |
| colinsurprenant/director | Go coordination tool         | Detected as adjacent coordination ledger; not an application with Director actively installed |

## What we should not claim yet

1. **A productivity win:** both controls solved their tasks. The sample is tiny and non-randomized;
   there is no measured speed, token, cost, or task-success advantage.
2. **Useful knowledge over time:** zero new knowledge avoids noise, but does not answer whether a
   validated lesson is saved and usefully retrieved later. Three tasks are not a long-term study.
3. **Zero-friction onboarding:** operators installed prerequisites, approved focused commands, and
   committed setup. The user-driven unassisted first-run experience remains under-tested.
4. **Universal compatibility:** native Ruby/PHP/Lua/Go/Rust/C workflows, live Claude Code, and an
   application with another coordinator were not exercised in the latest agent pass.
5. **All installation paths blocked:** Express/Nuxt/Astro probes used project-local installation or
   lockfile resolution, not every README `npx` path. Existing age policies were left unchanged.
6. **A proven timeout root cause:** Starlette passed 53 tests outside the command sandbox using the
   same approved policy and timeout. The original blocked agent task remains separately recorded;
   the specific sandbox/async-runtime cause is unproven.

## Prioritized recommendations

Effort below is relative, not a delivery estimate. These are proposed work, not changes already
implemented by this testing branch. Do not broaden permissions or bypass safeguards to improve
scores.

| Priority | Change                                                                                               | Why it matters                                                                         | Effort / quick win             | Acceptance evidence                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Add expected-file regressions for SvelteKit, jq, libsodium; then fix selection                       | Missing the implementation undermines the core context promise                         | Medium; highest product impact | Expected implementation enters bounded context; existing relevance cases do not regress                                           |
| P1       | One concise first-task path covering setup review, approved checks, finish, then commit              | Operator-assisted success can hide adoption friction                                   | Small; quick win for wording   | Fresh user follows the documented sequence; understands what changes and why a baseline is needed                                 |
| P1       | Improve timeout output and safe recovery guidance                                                    | A failed check should be actionable, not an unreadable dump or misleading green status | Small–medium                   | Show exact command, time limit, useful last output and an explicit failed state; regression tests cover truncation                |
| P1       | Test one deliberately reusable lesson across fresh tasks                                             | Tests the user's central concern: useful knowledge versus a silent redundant layer     | Medium, bounded experiment     | Validated lesson saved only when justified, selected on a relevant later task, excluded on unrelated task; compare without lesson |
| P2       | Explain package-age rejection without recommending policy bypass                                     | Fresh releases meet real dependency trust policies                                     | Small; quick win               | Document native error and supported next step; rerun exact install paths when normally eligible                                   |
| P2       | Review package-manager ambiguity and root instruction conflict messages                              | False conflict signals can block or worry users                                        | Medium                         | Pinned SvelteKit/Astro/Pluggy cases distinguish real conflicts from unrelated mentions; no silent overwrite                       |
| P2       | One application workflow with existing coordinator and instruction files                             | Detection alone does not prove coexistence                                             | Medium                         | Existing instructions preserved; clear ownership of lifecycle; no duplicate or contradictory task handling                        |
| P2       | Make the existing task ID easier to find in compact status/finish output if user testing warrants it | Helpful for resuming and identifying evidence without dumping logs                     | Small; conditional quick win   | One short identifier and actionable next step; verbose details remain opt-in; avoid inventing a second ID system                  |
| P3       | Broaden stacks and run a longer matched adoption study                                               | Useful after known misses and value questions are addressed                            | Large; not next                | Predefined outcomes, comparable controls, native checks, repeated tasks, knowledge relevance measurements                         |

No new critical runtime security issue was identified by this particular pass; that is not an
exhaustive security certification. The independent reviewer did find a cleanup-harness safeguard gap
involving already-staged files. The fix rejects staged/untracked/unexpected changes and compares the
checkpoint against exported evidence; four synthetic tests cover success and refusal cases.

## Recommended next slice

Ship no new feature merely to chase a numerical release score. First add the three selection
regressions, improve first-task and timeout wording, and run the bounded reusable-lesson experiment.
Then reassess. This offers more value than another unstructured batch of fifty repositories.

The current evidence supports sharing Noxroot as an early release with specific, bounded claims. It
does not justify a measured "9/10" rating, universal compatibility promise, or productivity claim.

## Evidence, versions, and cleanup

- [Pre-release breadth and native checks](REPORT-2026-09-03.md), with
  [pinned results](results-2026-09-03-final.json).
- [Published-package breadth](ADOPTION-2026-09-04.md), with
  [pinned results](adoption-results-2026-09-04.json).
- [Repeated workflows, controls, and failure details](WORKFLOWS-2026-09-04.md), with
  [structured results and cleanup status](workflow-results-2026-09-04.json).

The current branch adds opt-in acceptance tools, tests, and evidence; no runtime or npm release
change. Tests used disposable pinned copies, with explicitly authorized local-only commits and no
upstream remotes retained. Current-run cleanup is recorded in the structured workflow evidence.
Older unrelated temporary evidence and personal projects are outside this cleanup scope.

Final current-run cleanup removed the approximately 1.6 GB workspace
`/tmp/noxroot-workflows-5H3Bra`, retaining no treatment/control copies. Exported diffs and evidence
remain in this repository. Formatting, lint, typecheck, build, and 219 tests passed (two skipped);
the four explicit cleanup safeguards passed on Windows and WSL. The
[fresh reviewer approved](workflow-review-2026-09-04.json) the corrected cleanup logic and report.
