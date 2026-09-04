# Security and privacy model

Repository contents and agent output are untrusted. Detection does not follow symlinks or execute
repository instructions. It skips built-in generated/vendor directories, applies common `.gitignore`
rules, and never reads suspected secret files. Paths proposed for reads, writes, and process working
directories are resolved against the selected repository. Ordinary source and documentation remain
data; only designated Noxroot configuration and repository instruction files receive semantics.

Preview has no injected write, process, agent, network, telemetry, or local-state capability. Its
implementation uses canonical path resolution and bounded filesystem inspection only. Tests hash the
full fixture tree before and after preview, use scripts that would leave a marker if executed, block
symlink escapes, and assert secret values never reach output. `npx` may contact npm to download the
CLI and its dependencies before Noxroot starts. That retrieval is outside the runtime preview
boundary; the full `npx` invocation is not guaranteed offline. Generated lifecycle instructions pin
the package version. Review `sync --dry-run --diff` before changing that pin.

Mutating setup shows complete patches, rechecks target absence or the reviewed content hash, and
refuses symbolic links and junctions at write destinations or their ancestors. It checks all
destinations before writing, rechecks during application, and guards rollback paths too. Setup uses
same-directory temporary files with restrictive modes and preserves unmanaged content. These checks
are not an atomic filesystem transaction against a concurrent hostile process changing paths.
Process execution uses direct executable/argument arrays, repository-contained working directories,
timeouts, cancellation, a minimal environment, and output caps.

Delegated Git flow never resets, cleans, force-pushes, merges, deploys, or discards dirty work. It
snapshots approved verification policy before the worker. No credentials, private keys, raw chats,
reasoning traces, application sessions/memory/state, customer data, or production data belong in
project knowledge or test fixtures.

Guided start requires a clean committed baseline. Finish validates repository identity and the
policy snapshot, derives actual changed paths, includes bounded tracked and new-file diff evidence,
and treats zero matching checks or unavailable executables as blockers. Diff evidence records the
path but omits contents for suspected secrets, configured sensitive paths, and symlinks; the same
redaction applies to connected-agent reviewer packages. Freshness uses a separate full-change hash;
file contents are streamed into it, not retained in task state. Reviewer files are resolved inside
the dedicated untracked `.noxroot/local/` directory without following links and must satisfy the
same strict bound JSON contract as command reviewers. Invalid reviewer-file contents are discarded
rather than persisted as diagnostics.

Negative guarantees are release blockers. A newly discovered path to a preview write, child command,
agent call, network attempt, secret disclosure, or path escape requires a regression test before
release.
