# Agent and verification adapters

You do not need to configure an adapter to use Noxroot with your existing coding agent. After setup,
compatible agents follow the repository instructions and call the CLI themselves. Command adapters
let Noxroot launch optional delegated workers through `run` or automated reviewers through `run` and
`finish`.

## Manual

The default adapter emits the complete task package for use in any agent or chat. It reports zero
agent invocations and makes no repository change.

## Command

A command adapter has an id, executable, literal argument array, and timeout. Each invocation
receives one JSON line on standard input:

```json
{ "role": "worker", "taskPackage": { "task": "..." } }
```

The executable must understand this protocol. A vendor CLI name alone does not make it compatible;
use documented arguments or a wrapper that translates the task package. Install and authenticate
that tool separately. Noxroot does not supply provider accounts, credentials, or model access.

Roles are `worker`, `repair`, and `reviewer`. An automated reviewer must write exactly one version 2
JSON object to standard output. It must copy `taskId` and `changeId` from the reviewer package, then
provide `decision`, `summary`, `findings`, and `learningCandidates`. This binding prevents an older
or unrelated review from approving the current change. Findings require severity, evidence, and
required outcome; optional paths are repository-relative. Prose, additional text, missing fields,
unknown fields, a mismatched id, truncated output, nonzero exit, and a decision printed only on
standard error all block approval. Diagnostics remain separate on standard error. Every invocation
is a fresh process. Noxroot does not use a shell, interpolate repository text into arguments, bypass
permissions, or promise undocumented vendor flags.

Before delegated implementation, preflight resolves the configured executable, validates literal
arguments, checks repository write access and a committed Git baseline, and confirms executables for
the captured verification policy. A `healthCheck` may be configured as another literal command
array. Noxroot does not guess vendor authentication flags. A failed preflight preserves bounded
standard error, explains the failed prerequisite and exits before creating a worktree or run record.

The application itself may use an agent framework. That framework is analyzed as repository
architecture and can expose native tests/evals through `.noxroot/verification.yml`; it is not
installed or controlled as a Noxroot dependency. Project knowledge never absorbs the framework's
runtime sessions, state, memory, or user data.

## Verification

Verification adapters share the safe process primitive but use only commands confirmed in the
trusted policy captured before worker execution. A worker change to verification policy cannot
authorize a command in the same run.
