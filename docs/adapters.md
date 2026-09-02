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

Roles are `worker`, `repair`, and `reviewer`. Reviewers should return JSON containing
`{"decision":"approved"}`, `changes-requested`, or `blocked`; concise plain text containing the same
decision words is accepted as a fallback. Every invocation is a new child process with fresh input.
Noxroot does not use a shell, interpolate repository text into arguments, bypass permissions, or
promise support for undocumented vendor flags.

The application itself may use an agent framework. That framework is analyzed as repository
architecture and can expose native tests/evals through `.noxroot/verification.yml`; it is not
installed or controlled as a Noxroot dependency.

## Verification

Verification adapters share the safe process primitive but use only commands confirmed in the
trusted policy captured before worker execution. A worker change to verification policy cannot
authorize a command in the same run.
