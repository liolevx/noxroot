# Release acceptance follow-up

Performed September 3 in America/Toronto (September 4 UTC). Baseline: merged main
`a925fa78a5230c690cc18086bdca14995076638a`. Fix: `5f2463d`; packed regression checks: `fa87c13`. No
additional external repositories, product features, or dependencies.

## Independent review and fix

A fresh reviewer inspected the preceding implementation against `f4e906c` and ran 56 focused tests.
The review found a pre-existing release blocker: initialization followed a `.noxroot` junction and
wrote outside the selected repository even though preview reported the link.

Six regressions were added first. Five failed before the fix; all six pass afterward:

- Linked `.noxroot`, nested knowledge directory, and `AGENTS.md` destinations are refused.
- Direct application independently rejects unsafe destinations, even with caller-supplied approval.
- Links introduced after preview and a repository root replaced by a link are refused.
- Refusal leaves repository and outside content unchanged, including no partial setup files.
- An unrelated link does not prevent normal setup.

Preview now refuses unsafe writable destinations. Application checks every destination before its
first write, rechecks during application, and guards rollback paths. CLI refusal text now says
"setup conflict" rather than incorrectly calling every refusal an instruction conflict.

The reviewer independently rechecked the fix and ran 42 focused tests. The exact approval is in
[the review response](release-review-2026-09-04.json). These checks are not atomic protection
against a hostile concurrent filesystem writer; rollback can leave recovery artifacts rather than
follow a path that became unsafe. This limitation is stated in `docs/security.md`.

## Packed install and upgrade rehearsal

The existing package smoke test now installs the actual tarball and exercises its installed binary
on Windows and Linux. Dependencies are packed locally and installed offline with scripts disabled.

- Repeated initialization is byte-for-byte unchanged.
- A synthetic `0.0.9` managed pin is upgraded to the running `0.1.0` pin.
- `sync --dry-run --diff --json` reports exactly one `AGENTS.md` patch and makes no changes.
- Unconfirmed JSON sync is refused and makes no changes.
- Confirmed sync changes only that pin. User-owned instruction prefixes/suffixes, documentation,
  configuration, and project knowledge remain unchanged.
- A subsequent sync reports zero managed changes.
- Packed preview refuses linked setup destinations; packed init exits 3 and writes nothing outside
  or inside the test repository.

The older pin is synthetic, not an older published package. This does not test npm registry
retrieval or an actual migration between published releases.

## Validation

- Windows Node 24.13.0: `npm run check` passed, including all 184 unit tests, formatting, lint,
  typecheck, build, permission-confined compiled preview, and real package smoke.
- Linux Node 24.19.0: `node tests/acceptance/linux.mjs` passed from committed `fa87c13` in a clean
  temporary checkout: 182 tests passed, two Windows-only tests skipped, all other checks passed.
- `git diff --check` passed.
- Final report checks: all five documentation tests and `npm run format:check` passed.
- A fresh `npm audit --audit-level=high --json` stalled. A bounded retry with
  `--fetch-retries=0 --fetch-timeout=15000` timed out at the npm advisory endpoint. No fresh audit
  pass is claimed; dependencies and lockfile are unchanged from the preceding validated release.
- `npm pack --dry-run --json`: 120,983 packed bytes, 387,801 unpacked bytes. Compared with the
  preceding recorded package, +373 packed bytes and +2,553 unpacked bytes.
- Local Noxroot task `20260904-ba4005c6` finished as `approved`, using the actual independent review
  JSON. All five approved checks passed; no learning or knowledge document was proposed.

Runtime source change: four files, 66 added lines and 12 removed. README and visuals are unchanged;
this safety correction does not change the product description. The setup safety documentation was
updated, and the release evidence is retained separately from project knowledge.

## Remaining gate and cleanup

Still pending: a real signed-in compatible coding agent taking one task from the user's request
through start, change, verification, and finish, including continuation in a new conversation.
Standalone client authentication remains deferred until the user is available. Neither these tests
nor the review prove universal automatic invocation or long-term knowledge usefulness. The existing
thirty-repository report remains the breadth evidence; it was not expanded or rerun in this slice.

Repository: `C:/Users/lione/Documents/ChatGPT/noxroot`; branch: `agent/release-safety-acceptance`.
No additional worktrees or workspace-parent artifacts were created. Test-owned temporary fixtures,
package installations/caches, and the isolated Linux checkout were removed. The empty preparation
directory `C:/Users/lione/AppData/Local/Temp/noxroot-release-bef73e6d39d340ef9ac66a2b79933d0e` was
removed. Older unrelated temporary directories were left untouched. Local task evidence is retained
under `.git/noxroot`; no push, merge, npm publication, or deployment occurred in this slice.
