import type { ContextPackage, PreviewResult, VerificationResult } from "./model.js";

function section(title: string, lines: string[]): string[] {
  return lines.length > 0 ? ["", title, ...lines] : [];
}

export function renderPreview(result: PreviewResult): string {
  const lines = [
    "NOXROOT PREVIEW",
    "Read-only repository diagnosis",
    "",
    `Repository files changed: ${result.trust.repositoryFilesChanged}`,
    `Repository commands executed: ${result.trust.repositoryCommandsExecuted}`,
    `Agent calls made: ${result.trust.agentCallsMade}`,
    `Network requests made by Noxroot: ${result.trust.networkRequestsMade}`,
  ];
  lines.push(
    ...section(
      "Detected",
      result.profile.evidence.map((item) => {
        const marker =
          item.status === "confirmed" ? "✓" : item.status === "conflicting" ? "!" : "?";
        return `${marker} [${item.status}] ${item.claim}${item.sources.length ? ` — ${item.sources.join(", ")}` : ""}`;
      }),
    ),
  );
  lines.push(
    ...section(
      "Existing setup to reuse",
      result.existingSetup.map((item) => `- ${item}`),
    ),
  );
  lines.push(
    ...section(
      "Conflicts and limits",
      result.conflicts.map((item) => `- ${item}`),
    ),
  );
  if (result.profile.stats.incompleteReasons.length > 0) {
    lines.push(...result.profile.stats.incompleteReasons.map((item) => `- Incomplete: ${item}`));
  }
  if (result.profile.suspectedSecrets.length > 0) {
    lines.push(
      `- ${result.profile.suspectedSecrets.length} suspected secret file(s) were identified by name; contents were not read.`,
    );
  }
  lines.push(
    ...section(
      "Unknown",
      result.unknowns.map((item) => `? ${item}`),
    ),
  );
  lines.push(
    ...section(
      "Modules",
      result.modules.map((module) => `- ${module.label}: ${module.status} — ${module.reason}`),
    ),
  );
  lines.push("", `Proposed changes: ${result.proposedFiles.length} files`);
  for (const file of result.proposedFiles) {
    lines.push("", `${file.action.toUpperCase()} ${file.path}`, file.reason);
    if (file.patch) lines.push(file.patch.trimEnd());
  }
  lines.push(
    ...section(
      "Commands discovered but not run",
      result.profile.candidateCommands.map(
        (command) => `- ${[command.executable, ...command.args].join(" ")} — ${command.source}`,
      ),
    ),
  );
  lines.push(
    "",
    `Estimated default context: ${result.contextEstimate.defaultBytes} bytes (~${result.contextEstimate.estimatedTokens} tokens)`,
    "Next: noxroot init",
    "",
    "No repository changes were made.",
  );
  return `${lines.join("\n")}\n`;
}

export function renderContext(context: ContextPackage): string {
  const lines = [
    "NOXROOT CONTEXT",
    `Task: ${context.task}`,
    `Interpretation: ${context.interpretation}`,
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
  if (results.length === 0) return "NOXROOT VERIFY\nNo approved checks matched.\n";
  const lines = ["NOXROOT VERIFY"];
  for (const result of results) {
    lines.push(
      `- ${result.command.id}: ${result.status} (${result.evidence.durationMs}ms, exit ${result.evidence.exitCode ?? "signal"})`,
    );
  }
  return `${lines.join("\n")}\n`;
}
