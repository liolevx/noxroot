import type {
  CapabilityAssessment,
  ContextPackage,
  PreviewResult,
  VerificationResult,
} from "./model.js";
import { cliCommand, VERSION } from "./invocation.js";

export interface RenderOptions {
  color?: boolean;
  verbose?: boolean;
  width?: number;
}

const ANSI = {
  reset: "\u001B[0m",
  violet: "1;38;5;141",
  green: "1;38;5;78",
  yellow: "1;38;5;220",
  red: "1;38;5;203",
  blue: "1;38;5;117",
  bold: "1",
  dim: "2",
} as const;

function style(value: string, code: string, options: RenderOptions): string {
  return options.color ? `\u001B[${code}m${value}${ANSI.reset}` : value;
}

function title(label: string, options: RenderOptions): string {
  return `${style("NOXROOT", ANSI.violet, options)}  ${style(label, ANSI.dim, options)}`;
}

function section(
  label: string,
  values: string[],
  options: RenderOptions,
  color: string = ANSI.bold,
): string[] {
  if (values.length === 0) return [];
  return [style(label, color, options), ...values.map((value) => `  ${value}`), ""];
}

function sentenceCase(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

function commandText(command: { executable: string; args: string[] }): string {
  return [command.executable, ...command.args].join(" ");
}

function wrapItems(values: string[], width = 80, indent = 2): string[] {
  const available = Math.max(24, width - indent);
  const lines: string[] = [];
  for (const value of values) {
    const candidate = lines.length ? `${lines.at(-1)} · ${value}` : value;
    if (lines.length && candidate.length > available) lines.push(value);
    else if (lines.length) lines[lines.length - 1] = candidate;
    else lines.push(value);
  }
  return lines;
}

function capabilityLines(
  capabilities: CapabilityAssessment[],
  decision: CapabilityAssessment["decision"],
  options: RenderOptions,
): string[] {
  return capabilities
    .filter((item) => item.decision === decision)
    .map((item) => {
      if (!options.verbose) return item.label;
      const detail = [...item.evidence, ...item.missingEvidence].join("; ");
      return detail ? `${item.label}: ${detail}` : item.label;
    });
}

export function renderWelcome(options: RenderOptions = {}): string {
  const promise = [
    "Project memory and verification for coding agents.",
    "A CLI for task context, project checks, and reusable documentation.",
  ];
  const wordmark = ["█▄ █  █▀█  ▀▄▀  █▀█  █▀█  █▀█  ▀█▀", "█ ▀█  █▄█  █ █  █▀▄  █▄█  █▄█   █"];
  const compact = (options.width ?? 80) < 52;
  const mark = compact
    ? [
        `${style("NOXROOT", ANSI.violet, options)} ${style("◆", ANSI.blue, options)} ${style(VERSION, ANSI.dim, options)}`,
        ...promise.map((line) => style(line, ANSI.bold, options)),
      ]
    : [
        ...wordmark.map((line) => style(line, ANSI.violet, options)),
        `${style("◆", ANSI.blue, options)} ${style(VERSION, ANSI.dim, options)}`,
        "",
        ...promise.map((line) => style(line, ANSI.bold, options)),
      ];
  return `${[
    ...mark,
    "",
    ...section("Start here", ["noxroot preview", "noxroot init", "noxroot --help"], options),
  ].join("\n")}\n`;
}

export function renderInitMark(options: RenderOptions = {}): string {
  return `${style("NOXROOT", ANSI.violet, options)} ${style("◆", ANSI.blue, options)} ${style("setup", ANSI.dim, options)}\n\n`;
}

export function renderPreview(
  result: PreviewResult,
  options: RenderOptions & { diff?: boolean } = {},
): string {
  const manager =
    result.profile.packageManager.status === "confirmed"
      ? result.profile.packageManager.name
      : undefined;
  const detected = result.profile.evidence
    .filter(
      (item) =>
        item.status === "confirmed" &&
        !item.claim.startsWith("JavaScript package manager") &&
        !item.claim.startsWith("Existing ") &&
        item.claim !== "Git repository",
    )
    .map((item) =>
      item.claim
        .replace(/ source$/, "")
        .replace(/^Node\.js project$/, "Node.js")
        .replace(/^User-facing web application$/, "Web application"),
    );
  if (manager) detected.push(manager);
  const instructions = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"].filter(
    (file) => result.profile.files.includes(file),
  );
  const applicableModules = result.modules.filter((module) =>
    ["recommended", "enabled", "optional"].includes(module.status),
  );
  const unavailableModules = result.modules.filter((module) =>
    ["not applicable", "blocked"].includes(module.status),
  );
  const companionMode = result.capabilities.some(
    (item) => item.id === "task-orchestration" && item.decision === "conflict",
  );
  const contextOnlyMode = result.capabilities.some(
    (item) => item.id === "task-orchestration" && item.decision === "not-assessed",
  );
  const setupOnly = result.profile.empty;
  const conflictDetails = [
    ...result.conflicts,
    ...result.profile.stats.incompleteReasons,
    ...(result.profile.suspectedSecrets.length
      ? [`${result.profile.suspectedSecrets.length} suspected secret path(s) excluded`]
      : []),
  ];
  const lines = [
    title("preview", options),
    "",
    ...section(
      "Detected",
      detected.length
        ? wrapItems(detected, options.width)
        : ["No application architecture detected"],
      options,
    ),
    ...section(
      "Mode",
      [
        companionMode
          ? "Companion"
          : setupOnly
            ? "Setup only"
            : contextOnlyMode
              ? "Context only"
              : "Full",
      ],
      options,
    ),
    ...section(
      "Reuse",
      capabilityLines(result.capabilities, "reuse", options),
      options,
      ANSI.green,
    ),
    ...section(
      "Works alongside",
      capabilityLines(result.capabilities, "adjacent", options),
      options,
      ANSI.blue,
    ),
    ...section(
      "Add",
      capabilityLines(result.capabilities, "create", options),
      options,
      ANSI.violet,
    ),
    ...section(
      "Leave unchanged",
      capabilityLines(result.capabilities, "conflict", options),
      options,
      ANSI.yellow,
    ),
    ...section(
      "Not assessed",
      capabilityLines(result.capabilities, "not-assessed", options),
      options,
      ANSI.dim,
    ),
  ];

  if (options.verbose) {
    lines.push(
      ...section(
        "Proposed files",
        result.proposedFiles.map((item) => `${item.action} ${item.path}`),
        options,
      ),
      ...section(
        "Details",
        [
          `Existing instructions: ${instructions.join(", ") || "none"}`,
          `Approved checks: ${result.profile.candidateCommands.map((item) => item.id).join(", ") || "none"}`,
          `Initialization: ${result.initializationAllowed ? "allowed" : "refused"}`,
          `Context estimate: ~${result.contextEstimate.estimatedTokens.toLocaleString("en-US")} tokens`,
          `Unknown: ${result.unknowns.join(", ") || "none"}`,
          `Conflicts and limits: ${conflictDetails.join("; ") || "none"}`,
          `Applicable modules: ${applicableModules.map((item) => `${item.id} (${item.status})`).join(", ") || "none"}`,
          `Unavailable modules: ${unavailableModules.map((item) => `${item.id} (${item.status})`).join(", ") || "none"}`,
          `Preview activity: ${result.trust.repositoryFilesChanged} files changed; ${result.trust.repositoryCommandsExecuted} project commands; ${result.trust.agentCallsMade} agent calls; ${result.trust.networkRequestsMade} network requests`,
        ],
        options,
      ),
    );
  }

  if (options.diff && result.proposedFiles.length > 0) {
    lines.push(style("Exact proposed changes", ANSI.bold, options));
    for (const file of result.proposedFiles) {
      lines.push("", `${file.action.toUpperCase()} ${file.path}`, file.reason);
      if (file.patch) lines.push(file.patch.trimEnd());
    }
    lines.push("");
  }

  lines.push(
    result.initializationAllowed
      ? "No files changed. No project commands or agents ran. No network requests were made."
      : "Initialization refused. No files changed.",
    "",
    ...section(
      "Next",
      [
        !result.initializationAllowed
          ? "Resolve the reported instruction conflict."
          : result.proposedFiles.length === 0
            ? cliCommand('context "<task>"')
            : options.diff
              ? cliCommand("init")
              : cliCommand("preview --diff"),
      ],
      options,
      ANSI.blue,
    ),
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderContext(context: ContextPackage, options: RenderOptions = {}): string {
  const selectedPaths = new Set(context.selected.map((item) => item.path));
  const candidatePath = (pathname: string): string =>
    selectedPaths.has(pathname) ? pathname : `${pathname} (path match; inspect selectively)`;
  const selectedSummary = options.verbose
    ? `${context.selected.length} of ${context.repositoryFileCount} files · ~${context.budget.estimatedTokens.toLocaleString("en-US")} tokens`
    : `${context.selected.length} files · ~${context.budget.estimatedTokens.toLocaleString("en-US")} tokens`;
  const lines = [
    title("task brief", options),
    "",
    ...section(
      "Outcome",
      context.intent.requiredOutcomes.length
        ? context.intent.requiredOutcomes
        : ["Inspect the request and clarify the outcome."],
      options,
      ANSI.blue,
    ),
    `Confidence  ${sentenceCase(context.confidence)}`,
    "",
    ...(context.intent.explicitExclusions.length
      ? section("Do not", context.intent.explicitExclusions, options, ANSI.yellow)
      : []),
    ...section(
      "Task context",
      [selectedSummary, ...context.selected.map((item) => item.path)],
      options,
      ANSI.green,
    ),
    ...section(
      "Likely owner",
      context.likelyOwningSource.length
        ? context.likelyOwningSource.map(candidatePath)
        : ["Not established"],
      options,
    ),
    ...section(
      "Likely tests",
      context.likelyTests.length ? context.likelyTests.map(candidatePath) : ["Not established"],
      options,
    ),
    ...section(
      "Checks",
      context.requiredVerification.length
        ? context.requiredVerification.map(commandText)
        : ["No approved command is available."],
      options,
      ANSI.yellow,
    ),
    ...section("Excluded", [`${context.excluded.length} files left out`], options, ANSI.dim),
  ];

  if (options.verbose) {
    lines.push(
      ...section(
        "Selection reasons",
        context.selected.flatMap((item) => [
          `${item.path} (${item.bytes} bytes)`,
          ...item.reasons.map((reason) => `  ${reason}`),
        ]),
        options,
      ),
      ...section(
        "Excluded files",
        context.excluded.map((item) => `${item.path}: ${item.reason}`),
        options,
      ),
      ...section(
        "Details",
        [
          `Interpretation: ${context.interpretation}`,
          `Authority: ${context.intent.requestedAuthority.join(", ") || "local work only"}`,
          `Eligible candidates: ${context.eligibleCandidateFiles}`,
          `Budget: ${context.budget.selectedBytes}/${context.budget.maximumBytes} bytes`,
          `Conflicts: ${context.conflicts.join("; ") || "none"}`,
          `Unknowns: ${context.unknowns.join("; ") || "none"}`,
        ],
        options,
      ),
    );
  }

  lines.push(...section("Next", ["Build the requested change."], options, ANSI.blue));
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderVerificationPlan(
  changed: string[],
  checks: Array<{ executable: string; args: string[]; cwd: string }>,
  options: RenderOptions & { changedOnly?: boolean } = {},
): string {
  const lines = [
    title("check plan", options),
    "",
    ...section(
      "Scope",
      [
        options.changedOnly
          ? changed.length === 1
            ? "1 changed file"
            : `${changed.length} changed files`
          : "Entire repository",
      ],
      options,
    ),
  ];
  if (checks.length === 0) {
    lines.push(
      ...section("Incomplete", ["No approved checks match this change."], options, ANSI.yellow),
      ...section(
        "Next",
        ["Approve a relevant check before claiming verification."],
        options,
        ANSI.blue,
      ),
    );
  } else {
    lines.push(
      ...section(
        "Planned",
        checks.map((check) => `${commandText(check)} · cwd ${check.cwd || "."}`),
        options,
        ANSI.yellow,
      ),
      ...section("Next", [cliCommand("verify")], options, ANSI.blue),
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderVerification(
  results: VerificationResult[],
  options: RenderOptions = {},
): string {
  const lines = [title("check", options), ""];
  if (results.length === 0) {
    lines.push(
      ...section("Incomplete", ["No approved checks matched this change."], options, ANSI.yellow),
      ...section(
        "Next",
        ["Approve a relevant check before claiming verification."],
        options,
        ANSI.blue,
      ),
    );
    return `${lines.join("\n").trimEnd()}\n`;
  }

  for (const [status, label, color] of [
    ["passed", "Passed", ANSI.green],
    ["failed", "Failed", ANSI.red],
    ["timed-out", "Timed out", ANSI.yellow],
    ["unavailable", "Unavailable", ANSI.yellow],
  ] as const) {
    lines.push(
      ...section(
        label,
        results
          .filter((result) => result.status === status)
          .map(
            (result) =>
              `${result.command.id} · ${result.evidence.durationMs}ms · exit ${result.evidence.exitCode ?? "signal"}`,
          ),
        options,
        color,
      ),
    );
  }
  lines.push(
    ...section(
      "Next",
      [
        results.every((result) => result.status === "passed")
          ? "Continue with review or handoff."
          : "Resolve the failed or unavailable checks, then run verification again.",
      ],
      options,
      ANSI.blue,
    ),
  );
  return `${lines.join("\n").trimEnd()}\n`;
}
