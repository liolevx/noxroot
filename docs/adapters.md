# Agent and verification adapters

## Manual

The default adapter emits the complete task package for use in any agent or chat. It reports zero
agent invocations and makes no repository change.

## Command

A command adapter has an id, executable, literal argument array, and timeout. Each invocation
receives one JSON line on standard input:

```json
{ "role": "worker", "taskPackage": { "task": "..." } }
```

Roles are `worker`, `repair`, and `reviewer`. An automated reviewer must write exactly one JSON
object to standard output with `decision`, `summary`, `findings`, and `learningCandidates`. Findings
require severity, evidence, and required outcome; optional paths are repository-relative. Prose,
additional text, missing fields, unknown fields, truncated output, nonzero exit, and a decision
printed only on standard error all block approval. Diagnostics remain separate on standard error.
Every invocation is a fresh process. Noxroot does not use a shell, interpolate repository text into
arguments, bypass permissions, or promise undocumented vendor flags.

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
