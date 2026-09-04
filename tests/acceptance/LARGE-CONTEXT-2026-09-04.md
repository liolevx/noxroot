# Large-file context acceptance

Baseline: `3739d39`. This slice addresses the context-selection failures recorded in
[legacy acceptance](LEGACY-ACCEPTANCE-2026-09-04.md), without adding repositories, model calls,
dependencies, source indexes, or persisted summaries.

## Changes

- Fresh setup includes root-level source extensions in its routes. Existing routes are preserved.
- Inspection reads at most 96,000 bytes per candidate and 1,000,000 bytes overall, rather than
  skipping every file above the per-file inspection limit. Incomplete inspection is reported.
- Large source/test files can contribute up to three non-overlapping reading windows, at most 3,000
  bytes per file and always within the configured context budget. JSON stores line ranges and byte
  counts, not source text. Human output labels partial selections.
- Standalone `test.py`-style files no longer count as implementation owners. Generic `test` path
  matches and weak single-word content matches no longer fill the brief with unrelated tests or
  adapters. Camel-case symbols retain their full name alongside component words; integer/int and
  minified/minify/min terminology is normalized.
- Minified duplicates are excluded unless requested. Missing owners, omitted implementation, partial
  files, bounded inspection, and missing check evidence prevent high confidence.

## Test-first evidence

Nine focused tests cover large generic implementation files, exact UTF-8/CRLF range bytes,
determinism, test classification, omitted owners, inspection limits, sensitive/custom routes, fresh
initialization, explicit minified targets, and a smaller configured budget. Four initial tests
failed before implementation. Both setup-route tests failed before the route correction. Additional
weak-match and explicit-minified assertions also failed before their corrections. The previous
oversized-owner regression now expects labelled ranges rather than complete omission.

The independent reviewer requested a correction for explicit minified-file targeting. That failure
is fixed and covered by both descriptive and filename requests. The final
[independent review](large-context-review-2026-09-04.json) approved the slice after 59 focused
tests.

Full local Windows `npm run check` passed: formatting, lint, typecheck, 214 passing tests with two
platform-specific skips, build, permission-confined preview, and installed-package smoke. The
existing 30-case synthetic routing benchmark and 600-record retention regression remain in the
suite. These are not 30 newly tested real repositories or 600 autonomous sessions.

## Packed CLI on the same two legacy projects

`large-file-context.mjs` packs and installs the real CLI with dependency install scripts disabled.
It reads the retained checkouts, archives their committed source into disposable non-Git copies,
reviews preview proposals, initializes only those copies, and reuses the earlier operator-approved
check configuration. It does not credit automatic discovery with finding those commands.

| Project          | Selected implementation                                                      | Related tests                                         | Whole brief                      | Confidence |
| ---------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------- | ---------- |
| Underscore 1.8.3 | `underscore.js`: 400–412, 484–496, 1069–1081; 1,499 selected bytes of 52,919 | `test/collections.js`: 649–661; also `test/arrays.js` | 7,759 bytes, about 1,940 tokens  | Partial    |
| Bottle 0.12.25   | `bottle.py`: 292–304, 765–777, 1295–1307; 1,913 selected bytes of 151,993    | `test/test_router.py`                                 | 10,899 bytes, about 2,725 tokens | Partial    |

Pinned revisions remain `e4743ab712b8ab42ad4ccb48b155034d02394e4d` and
`40aec5d4cca6ff4fbd73f4080554580fe4f5c212`. Assertions verify the selected source includes the
actual `groupBy` implementation and integer-conversion filter, that range bytes match the files, and
that repeated context is deterministic and below 16,000 bytes. Hashes prove context did not change
either retained repositories or disposable source copies. The probes do not execute project tests or
implement features; the preceding report covers those lifecycle workflows.

Before this slice, the main implementation was missing from both briefs. The improved results above
use fresh routes on committed source copies, not an automatic migration of the previously
initialized working trees. Those retained trees still have their old route restrictions. The CLI now
reports insufficient context and points to reviewing `.noxroot/routes.yml`; it does not ignore or
silently replace those boundaries. No reinitialization is required to make a reviewed route edit.

## Limits and release gate

These are lexical reading hints, not AST-complete functions or proof that every relevant behavior
was found. Secondary ranges can still be less relevant. Code after the inspected prefix can be
missed, and line numbers must be refreshed after edits. Partial confidence is intentional, not an
acceptance failure or permission to skip surrounding source. Existing simple-repository behavior
remains covered by the full suite.

The packed candidate is 126,481 bytes, 2,086 bytes above the preceding 124,395-byte candidate. No
runtime dependencies were added. README changes only the large-file limitation paragraph; the intro,
tagline, and visuals are unchanged. Command documentation explains the new metadata, inspection
limits, and existing-route behavior. Test harnesses and reports are not shipped.

The final committed tree must also pass the clean Linux runner and the six checks on
[PR #9](https://github.com/liolevx/noxroot/pull/9). The PR is the source of truth for final
Windows/macOS/Linux and Node-version results. No merge, npm publication, or deployment is
authorized.

### Windows CI follow-up

The first CI run passed five jobs and all nine new context tests, but the existing Windows Corepack
smoke hit its 15-second test deadline and cleanup encountered a locked directory. That test ran
unpinned `pnpm --version` from an empty directory, allowing Corepack registry lookup and download
inside the test. Its child and outer deadlines were also identical.

CI now prepares `pnpm@10.0.0` separately, with automatic latest-version promotion disabled. The test
pins the same version and disables networking through the process adapter's explicit environment. It
still requires exit zero, exact version output, no timeout, and the Node/Corepack invocation path.
Only this test gets a 30-second outer deadline, leaving room for the unchanged 15-second child
deadline and termination. A missing cache failed promptly in the local test; after preparation in an
isolated cache, all ten process tests and full Windows validation passed. The
[review](corepack-review-2026-09-04.json) approved the correction. Its documentation caveat was
addressed by disabling promotion in CI and removing the unconditional default-preservation claim. No
production code or success criterion was weakened. The latest PR run remains the final gate.

All `/tmp/noxroot-large-context-*` source copies, installs, packages, and caches were removed by the
harness, including failed attempts. The prior 4.7 MB evidence directory
`/tmp/noxroot-legacy-acceptance-4KcWWC` remains unchanged. No worktrees or workspace-parent
artifacts were created. Repository: `C:/Users/lione/Documents/ChatGPT/noxroot`; branch:
`agent/sandbox-lifecycle-quiet-output`.
