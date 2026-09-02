# Architecture

Noxroot is one Node.js/TypeScript package. The CLI layer parses input and keeps machine output
separate from diagnostics. Core functions return typed values and do not write implicitly. Detection
uses bounded filesystem APIs, never project execution or an LLM. Proposal generation produces
complete file contents and unified creation patches. Initialization is the only component that
applies those proposals.

Verification configuration distinguishes candidate discovery from executable trust. The process
adapter accepts an executable and argument array, validates the working directory, uses
`shell: false`, inherits a small environment allowlist, bounds output, and records timeout/exit
evidence.

The orchestrator accepts adapter, verification, and diff interfaces. This permits a deterministic
fake in tests and keeps worker/reviewer invocations distinct. Delegated Git runs create `noxroot/*`
branches and worktrees; local evidence is stored under the Git common directory, not
`.noxroot/knowledge/`.

Committed knowledge is stable, medium-grained Markdown/YAML. Active coordination state is local and
retained separately. Application-agent frameworks remain application architecture: their sessions,
state, memory, and user data are not Noxroot project knowledge. The MVP uses generic repository
detection, approved native tests/evals, and the command-adapter protocol; framework-specific
semantic modules are deferred.

Trust boundaries are described in [security.md](security.md). Public behavior belongs in tests
before it is claimed in the README.
