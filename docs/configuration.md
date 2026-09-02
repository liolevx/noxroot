# Configuration

`.noxroot/config.yml` uses schema version 1. Invalid values produce a file and field path. Versions
other than 1 are rejected instead of guessed.

```yaml
version: 1
modules:
  - repository-profile
  - agent-routing
roots: [.]
entrypoints: [AGENTS.md]
context:
  budgetBytes: 48000
  documentWarningBytes: 24000
autonomy:
  default: 0
  implementation: 2
  review: 3
  merge: 0
  delivery: 0
agents:
  default: local-agent
  adapters:
    manual:
      type: manual
    local-agent:
      type: command
      executable: my-agent
      args: [run, --non-interactive]
      timeoutMs: 600000
budgets:
  workerCalls: 2
  reviewerCalls: 2
  repairIterations: 1
  outputBytes: 65536
sensitivePaths: []
retention:
  evidenceDays: 30
  maximumRuns: 100
browser:
  verificationCommandId: browser-e2e
  baseUrl: http://127.0.0.1:3000
  viewports:
    - { name: mobile, width: 390, height: 844 }
```

Autonomy levels 4 and 5 are reserved but `merge` and `delivery` are schema-capped at level 3 and
operationally disabled. Agent command arguments are literal arrays; task packages are sent over
standard input. Never put credentials in configuration, arguments, prompts, or knowledge.

Confirmed checks live separately in `.noxroot/verification.yml`:

```yaml
version: 1
commands:
  - id: test
    executable: npm
    args: [test]
    cwd: .
    timeoutMs: 120000
    appliesTo: [src/**, tests/**]
```

Routes live in `.noxroot/routes.yml`. Each route has an id, match patterns, included paths, and
explicit exclusions. Current routing combines those durable entrypoints with deterministic task/path
evidence and enforces the configured byte budget.

`entrypoints` selects thin vendor-facing instruction files without duplicating canonical knowledge.
`browser` is optional and must reference an already confirmed verification command; preview never
installs browser tooling or starts an application.
