# Architecture

Noxroot is one Node.js/TypeScript package. The CLI layer parses input and keeps machine output
separate from diagnostics. Core functions return typed values and do not write implicitly. Detection
uses bounded filesystem APIs, groups repeated monorepo evidence, and never runs project code or an
LLM. Proposal generation produces complete file contents and unified creation patches.
Initialization is the only component that applies those proposals.

Root `AGENTS.md` and `CLAUDE.md` remain instruction evidence when Git ignores them. Explicit
sensitive-path exclusions and symlink protections still apply. Ordinary ignored files stay excluded.

Mature-repository adoption follows explicit repository-relative references from agent instructions.
It recognizes thin forwarding files, existing Agent Skills, documented verification wrappers, and
clear repository-development coordinator overlap. Behavioral ownership determines the boundary: a
coordination ledger, session journal, or issue tracker does not satisfy Noxroot task orchestration.
It is reported as an adjacent capability when durable work state, cross-session continuity, and
coding-work coordination are all evidenced. Noxroot does not infer this boundary from a product
name, filename, or implementation language. Proposal decisions are deliberately small: create a
proven gap, reuse explicit evidence, disable an overlapping capability, or preserve a capability
that could not be assessed. An existing coordinator keeps lifecycle, review, and learning authority
while Noxroot may add only non-overlapping context and verification support. Noxroot does not
interpret arbitrary route schemas or integrate coordinators. Task-route reuse requires a
repository-work context in the reference, not merely API documentation containing the word "routes".

Generated knowledge indexes link at most twelve high-signal documents. Additional documentation
stays in its original location and remains available through repository instructions and task
context. Translations of one document count as one family in the index. Independent example
collections require selecting one contained project before setup. Verification command ids include
their project path when nested project names repeat.

Verification configuration distinguishes candidate discovery from executable trust. The process
adapter accepts an executable and argument array, validates the working directory, uses
`shell: false`, inherits a small environment allowlist, bounds output, and records timeout/exit
evidence.

The orchestrator accepts adapter, verification, and diff interfaces. This permits a deterministic
fake in tests and keeps worker/reviewer invocations distinct. Delegated Git runs create `noxroot/*`
branches and worktrees; local evidence is stored under the Git common directory, not
`.noxroot/knowledge/`.

Guided orchestration is a two-command lifecycle. Start persists repository identity, clean revision,
bounded context, effective autonomy, and a hash of the approved verification policy. Finish derives
the real diff and affected checks from that snapshot, then emits a portable reviewer package or a
strict decision. Local state is never treated as application runtime state.

Completed and approved local records are pruned by age and count after a run finishes. Running,
incomplete, failed, blocked, review-pending, and malformed recovery evidence is never removed by
automatic retention.

Review applicability is recomputed from the actual diff after affected checks pass. Routine bounded
changes can complete without review; user-facing, security-sensitive, or broad changes request the
relevant fresh review. `completed` means applicable checks passed without a required reviewer;
`approved` is reserved for a schema-valid independent reviewer. Incomplete verification can be
handed off locally but cannot become approved.

Project memory is durable repository knowledge. Task state is temporary evidence for one bounded
change. External work ledgers may preserve cross-session coordination, but Noxroot neither imports
their logs into project memory nor treats them as repository-development coordinators.

Committed knowledge is stable, medium-grained Markdown/YAML. Active coordination state is local and
retained separately. Application-agent frameworks remain application architecture: their sessions,
state, memory, and user data are not Noxroot project knowledge. The MVP uses generic repository
detection, approved native tests/evals, and the command-adapter protocol; framework-specific
semantic modules are deferred.

Controlled learning consumes deterministic verification evidence or already parsed structured
reviewer candidates. Deterministic signatures deduplicate Noxroot-owned knowledge; first creation
also updates the index. Every proposed entry names its confirmation date and source task. Per-file
and total corpus bounds prevent accumulated Markdown from silently consuming future context.
Learning writes are capped at 1,000,000 bytes across Markdown files, including nested files and
index growth. The limit is rechecked when a proposal is applied. Symbolic-link destinations are
refused. A full destination requires deliberate consolidation before another write. Canonical
`.noxroot/skills/*/SKILL.md` files are short, standards-compatible procedures selected through
ordinary routing, not a new skill runtime or vendor-specific tree.

Trust boundaries are described in [security.md](security.md). Public behavior belongs in tests
before it is claimed in the README.

## Post-MVP client integration

Native lifecycle integration is deferred. Any client adapter must preview its exact configuration
changes, mark every owned entry, install idempotently, remove only Noxroot-owned entries, fail open
when unavailable, and let `doctor` verify that the integration actually runs. The CLI, Markdown,
JSON, and generic command adapter remain the universal contract.
