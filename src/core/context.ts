import path from "node:path";
import { loadConfig, loadRoutes, loadVerification } from "../config/load.js";
import { scanRepository } from "../detection/scan.js";
import type { CandidateCommand, ContextPackage, ContextSelection } from "../model.js";

const ALWAYS_CONTEXT = new Set(["AGENTS.md", ".noxroot/config.yml", ".noxroot/knowledge/INDEX.md"]);

const SOURCE_EXTENSION = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|cs|rb|php)$/;
const TEST_PATH = /(?:^|\/)(?:tests?|e2e|specs?)(?:\/|$)|\.(?:test|spec)\./;
const CONFIG_OR_DOC = /(?:^|\/)(?:docs?|\.github)(?:\/|$)|\.(?:md|ya?ml|json|toml)$/;

function words(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])];
}

function matchesGlob(pattern: string, file: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${escaped}$`).test(file);
}

function scorePath(
  file: string,
  terms: string[],
  routedIncludes: string[],
): { score: number; reasons: string[] } {
  const lower = file.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  if (ALWAYS_CONTEXT.has(file)) {
    score += 100;
    reasons.push("default progressive-disclosure path");
  }
  for (const term of terms) {
    if (lower.includes(term)) {
      score += 20;
      reasons.push(`path matches “${term}”`);
    }
  }
  if (SOURCE_EXTENSION.test(file) && !TEST_PATH.test(file)) {
    score += 2;
    reasons.push("candidate source");
  }
  if (TEST_PATH.test(file)) {
    score += 1;
    reasons.push("candidate verification");
  }
  if (file.startsWith(".noxroot/knowledge/")) {
    score += 8;
    reasons.push("accepted project knowledge");
  }
  if (
    file === "package.json" ||
    file === "pyproject.toml" ||
    file === "Cargo.toml" ||
    file === "go.mod"
  ) {
    score += 12;
    reasons.push("authoritative manifest");
  }
  if (routedIncludes.some((pattern) => matchesGlob(pattern, file))) {
    score += 15;
    reasons.push("matched an active context route");
  }
  return { score, reasons };
}

function approvedCommands(
  config: Awaited<ReturnType<typeof loadVerification>>,
): CandidateCommand[] {
  return (config?.commands ?? []).map((command) => ({
    id: command.id,
    executable: command.executable,
    args: command.args,
    cwd: command.cwd,
    source: ".noxroot/verification.yml",
    appliesTo: command.appliesTo,
  }));
}

export async function buildContext(task: string, root = process.cwd()): Promise<ContextPackage> {
  const config = await loadConfig(root);
  const profile = await scanRepository(path.resolve(root), {
    sensitivePaths: config?.sensitivePaths ?? [],
  });
  const routes = await loadRoutes(root);
  const verification = await loadVerification(root);
  const budget = config?.context.budgetBytes ?? 48_000;
  const terms = words(task);
  const activeRoutes = (routes?.routes ?? []).filter((route) =>
    route.match.some(
      (pattern) => pattern === "**/*" || terms.some((term) => pattern.toLowerCase().includes(term)),
    ),
  );
  const routedIncludes = activeRoutes.flatMap((route) => route.include);
  const routedExcludes = activeRoutes.flatMap((route) => route.exclude);
  const ranked = profile.files
    .filter((file) => !profile.suspectedSecrets.includes(file))
    .filter((file) => !routedExcludes.some((pattern) => matchesGlob(pattern, file)))
    .map((file) => ({
      file,
      ...scorePath(file, terms, routedIncludes),
      bytes: profile.fileSizes[file] ?? 0,
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file));
  const selected: ContextSelection[] = [];
  const excluded: Array<{ path: string; reason: string }> = [];
  let selectedBytes = 0;
  for (const item of ranked) {
    if (selected.length >= 40) {
      excluded.push({ path: item.file, reason: "selection count limit" });
      continue;
    }
    if (selectedBytes + item.bytes > budget && !ALWAYS_CONTEXT.has(item.file)) {
      excluded.push({ path: item.file, reason: "context byte budget" });
      continue;
    }
    selected.push({
      path: item.file,
      bytes: item.bytes,
      estimatedTokens: Math.ceil(item.bytes / 4),
      reasons: item.reasons,
    });
    selectedBytes += item.bytes;
  }
  const likelyOwningSource = ranked
    .filter((item) => SOURCE_EXTENSION.test(item.file) && !TEST_PATH.test(item.file))
    .slice(0, 8)
    .map((item) => item.file);
  const likelyTests = ranked
    .filter((item) => TEST_PATH.test(item.file))
    .slice(0, 8)
    .map((item) => item.file);
  const applicableAreas = [
    ...new Set(
      [...likelyOwningSource, ...likelyTests]
        .map((file) => file.split("/")[0])
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const unselectedDocs = ranked.filter(
    (item) => CONFIG_OR_DOC.test(item.file) && !selected.some((entry) => entry.path === item.file),
  );
  excluded.push(
    ...unselectedDocs.slice(0, 10).map((item) => ({
      path: item.file,
      reason: "not relevant enough to this task",
    })),
  );
  return {
    task,
    interpretation: `Work is bounded to evidence relevant to: ${task}`,
    applicableAreas,
    selected,
    likelyOwningSource,
    likelyTests,
    constraints: selected
      .filter((item) => item.path.includes("knowledge/") || item.path.endsWith("AGENTS.md"))
      .map((item) => `Read ${item.path} before changing its routed surface.`),
    requiredVerification: approvedCommands(verification),
    conflicts: profile.evidence
      .filter((item) => item.status === "conflicting")
      .map((item) => item.claim),
    unknowns: [
      ...(likelyOwningSource.length ? [] : ["Owning source path"]),
      ...(verification?.commands.length ? [] : ["Approved verification command"]),
    ],
    excluded: excluded.filter(
      (item, index, all) => all.findIndex((candidate) => candidate.path === item.path) === index,
    ),
    budget: {
      maximumBytes: budget,
      selectedBytes,
      estimatedTokens: Math.ceil(selectedBytes / 4),
    },
  };
}
