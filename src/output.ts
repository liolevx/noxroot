import type { ContextPackage, PreviewResult, VerificationResult } from "./model.js";

export function renderPreview(result: PreviewResult, options: { diff?: boolean } = {}): string {
  const manager =
    result.profile.packageManager.status === "confirmed"
      ? ` (${result.profile.packageManager.name})`
      : "";
  const detected = result.profile.evidence
    .filter(
      (item) =>
        item.status === "confirmed" &&
        !item.claim.startsWith("JavaScript package manager") &&
        item.claim !== "Git repository",
    )
    .map((item) => item.claim.replace(/ source$/, ""));
  const actionCounts = new Map<string, number>();
  for (const proposal of result.proposedFiles) {
    actionCounts.set(proposal.action, (actionCounts.get(proposal.action) ?? 0) + 1);
  }
  const actionSummary = [...actionCounts.entries()]
    .map(([action, count]) => `${action} ${count}`)
    .join(", ");
  const instructions = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"].filter(
    (file) => result.profile.files.includes(file),
  );
  const applicableModules = result.modules.filter((module) =>
    ["recommended", "enabled", "optional"].includes(module.status),
  );
  const unavailableModules = result.modules.filter((module) =>
    ["not applicable", "blocked"].includes(module.status),
  );
  const lines = [
    "NOXROOT PREVIEW",
    `Detected: ${detected.join(", ") || "No application architecture yet"}${manager}`,
    `Existing instructions: ${instructions.join(", ") || "none"}`,
    `Approved check candidates found: ${result.profile.candidateCommands.map((item) => item.id).join(", ") || "none"}`,
    `Proposed (${result.proposedFiles.length}): ${actionSummary || "no setup changes"}`,
    `Files: ${result.proposedFiles.map((item) => `${item.action} ${item.path}`).join(", ") || "none"}`,
    `Applicable modules: ${applicableModules.map((item) => `${item.id} (${item.status})`).join(", ") || "none"}`,
    `Unavailable modules: ${unavailableModules.map((item) => `${item.id} (${item.status}: ${item.reason})`).join(", ") || "none"}`,
    `Unknown: ${result.unknowns.join(", ") || "none"}`,
    `Conflicts/limits: ${
      [
        ...result.conflicts,
        ...result.profile.stats.incompleteReasons,
        ...(result.profile.suspectedSecrets.length
          ? [`${result.profile.suspectedSecrets.length} suspected secret path(s) excluded`]
          : []),
      ].join("; ") || "none"
    }`,
    `Estimated default context: ${result.contextEstimate.defaultBytes} bytes (~${result.contextEstimate.estimatedTokens} tokens)`,
    `Trust: files changed ${result.trust.repositoryFilesChanged}; repository commands ${result.trust.repositoryCommandsExecuted}; agent calls ${result.trust.agentCallsMade}; network requests ${result.trust.networkRequestsMade}.`,
  ];
  if (options.diff && result.proposedFiles.length > 0) {
    lines.push("", "Exact proposed changes");
    for (const file of result.proposedFiles) {
      lines.push("", `${file.action.toUpperCase()} ${file.path}`, file.reason);
      if (file.patch) lines.push(file.patch.trimEnd());
    }
  }
  lines.push(
    "",
    "No repository files changed. No project command, agent, or network request ran.",
    result.proposedFiles.length === 0
      ? 'Next: no setup changes are recommended; run noxroot context "<task>".'
      : options.diff
        ? "Next: noxroot init"
        : "Next: noxroot preview --diff",
  );
  return `${lines.join("\n")}\n`;
}

export function renderContext(context: ContextPackage): string {
  const lines = [
    "NOXROOT CONTEXT",
    `Task: ${context.task}`,
    `Interpretation: ${context.interpretation}`,
    `Required outcomes: ${context.intent.requiredOutcomes.join("; ") || "inspect and clarify"}`,
    `Explicit exclusions: ${context.intent.explicitExclusions.join("; ") || "none"}`,
    `Requested authority: ${context.intent.requestedAuthority.join(", ") || "local work only"}`,
    `Confidence: ${context.confidence}`,
    "",
    `Selected ${context.selected.length} of ${context.repositoryFileCount} repository files (${context.eligibleCandidateFiles} eligible) · ${context.budget.selectedBytes}/${context.budget.maximumBytes} bytes (~${context.budget.estimatedTokens} tokens)`,
    ...context.selected.map(
      (item) => `- ${item.path} (${item.bytes} bytes): ${item.reasons.join("; ")}`,
    ),
    "",
    "Likely owning source",
    ...(context.likelyOwningSource.length
      ? context.likelyOwningSource.map((item) => `- ${item}`)
      : ["- Unknown"]),
    "",
    "Likely tests",
    ...(context.likelyTests.length
      ? context.likelyTests.map((item) => `- ${item}`)
      : ["- Unknown"]),
    "",
    "Required verification",
    ...(context.requiredVerification.length
      ? context.requiredVerification.map((item) => `- ${item.executable} ${item.args.join(" ")}`)
      : ["- No approved command is available."]),
  ];
  if (context.excluded.length > 0) {
    lines.push(
      "",
      "Deliberately excluded",
      ...context.excluded.map((item) => `- ${item.path}: ${item.reason}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderVerification(results: VerificationResult[]): string {
  if (results.length === 0)
    return "NOXROOT VERIFY\nVerification incomplete: no approved checks matched.\n";
  const lines = ["NOXROOT VERIFY"];
  for (const result of results) {
    lines.push(
      `- ${result.command.id}: ${result.status} (${result.evidence.durationMs}ms, exit ${result.evidence.exitCode ?? "signal"})`,
    );
  }
  return `${lines.join("\n")}\n`;
}
