# Security and privacy model

Repository contents and agent output are untrusted. Detection follows neither symlinks nor
repository instructions, skips built-in generated/vendor directories, applies common `.gitignore`
rules, and never reads suspected secret files. Paths proposed for reads, writes, and process working
directories are resolved against the selected repository. Ordinary source and documentation remain
data; only designated Noxroot configuration and repository instruction files receive semantics.

Preview has no injected write, process, agent, network, telemetry, or local-state capability. Its
implementation uses canonical path resolution and bounded filesystem inspection only. Tests hash the
full fixture tree before and after preview, use scripts that would leave a marker if executed, block
symlink escapes, and assert secret values never reach output. Package-manager retrieval, when a user
chooses it after publication, occurs outside the runtime preview boundary.

Mutating setup shows complete patches, rechecks target absence, writes same-directory temporary
files with restrictive modes, renames them into place, and never overwrites existing content.
Process execution uses direct executable/argument arrays, repository-contained working directories,
timeouts, cancellation, a minimal environment, and output caps.

Delegated Git flow never resets, cleans, force-pushes, merges, deploys, or discards dirty work. It
snapshots approved verification policy before the worker. No credentials, private keys, raw chats,
reasoning traces, application sessions/memory/state, customer data, or production data belong in
project knowledge or test fixtures.

Guided start requires a clean committed baseline. Finish validates repository identity and the
policy snapshot, derives actual changed paths, includes bounded tracked and new-file diff evidence,
and treats zero matching checks or unavailable executables as blockers. Reviewer files are resolved
inside the repository and must satisfy the same strict JSON contract as command reviewers.

Negative guarantees are release blockers. A newly discovered path to a preview write, child command,
agent call, network attempt, secret disclosure, or path escape requires a regression test before
release.
