# Configuration

`.noxroot/config.yml` uses schema version 1. Invalid values produce a file and field path. Versions
other than 1 are rejected instead of guessed.

Start with the configuration proposed by `init`; do not replace it with this reference example.
Schema version `1` is separate from the npm package version. Updating the CLI does not authorize new
checks or rewrite your task routes.

```yaml
version: 1
modules:
  - repository-profile
  - agent-routing
roots: [.]
entrypoints: [AGENTS.md]
context:
  budgetBytes: 16000
  documentWarningBytes: 24000
autonomy:
  default: 0
  implementation: 2
  review: 3
  merge: 0
  delivery: 0
agents:
  default: manual
  adapters:
    manual:
      type: manual
    local-agent:
      type: command
      executable: my-agent
      args: [run, --non-interactive]
      timeoutMs: 600000
      healthCheck:
        executable: my-agent
        args: [status]
        timeoutMs: 10000
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

The optional `local-agent` entry illustrates the adapter shape, not working flags for a particular
coding tool. Leave `manual` selected for the normal workflow where your existing agent calls
Noxroot. Command adapters are optional for delegated workers or automated review; see the
[adapter protocol](adapters.md). The sample `browser-e2e` id must refer to a check you actually
approved before enabling `browser`.

Autonomy is enforced, never descriptive-only: level 0 permits read-only diagnosis/context/plans;
implementation level 1 permits guided records; implementation level 2 permits a configured worker;
review level 3 permits independent reviewer and bounded repair calls. Higher configured values are
effectively capped at 3. `merge` and `delivery` are operationally disabled in the MVP regardless of
their fields. Agent arguments are literal arrays and task packages use standard input. Never put
credentials in configuration, arguments, prompts, or knowledge. The optional health command is never
inferred: configure it only when the selected agent documents a safe non-mutating health or
authentication-status command.

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

`retention.evidenceDays` expires completed or approved local run evidence by age.
`retention.maximumRuns` caps the retained record count. Active and recoverable states are protected
even when they exceed the cap. `context.documentWarningBytes` is also the hard ceiling for appending
new Noxroot-owned learning; reaching it requires deliberate consolidation.

`entrypoints` selects thin vendor-facing instruction files without duplicating canonical knowledge.
`browser` is optional and must reference an already confirmed verification command; preview never
installs browser tooling or starts an application.

When an existing repository coordinator owns code-changing work, generated companion configuration
omits `orchestration` and `learning`. The CLI then refuses Noxroot lifecycle commands instead of
creating a second authority. A documented repository verification wrapper can be reused directly
without copying its policy into `.noxroot/verification.yml`.

For JavaScript repositories, candidate commands use an authoritative `packageManager` declaration,
then an unambiguous lockfile, then consistent CI evidence. npm, pnpm, Yarn, and Bun are supported.
Missing or conflicting evidence produces no guessed command and preview never installs a manager or
runs Corepack.

For Python, explicit `pytest`, Ruff, or mypy tool configuration can produce a scoped candidate using
the repository's `uv.lock` when present. Cargo and Go manifests produce their conventional native
test/check candidates. These remain proposals until accepted into verification policy; discovery
never executes or installs them.
