import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, loadRoutes, loadVerification } from "../config/load.js";
import { scanRepository } from "../detection/scan.js";
import { inspectRepositoryAdoption } from "../detection/adoption.js";
import type { CandidateCommand, ContextPackage, ContextSelection } from "../model.js";
import { resolveWithin } from "../security/paths.js";
import { parseTaskIntent, relevantIntentText } from "./intent.js";

const DEFAULT_CONTEXT_BUDGET = 16_000;
const MAX_SELECTED_FILES = 24;
const MAX_CONTENT_INSPECTIONS = 400;
const MAX_CONTENT_BYTES = 1_000_000;
const MAX_INSPECTED_FILE_BYTES = 96_000;

const ALWAYS_CONTEXT = new Set(["AGENTS.md", ".noxroot/config.yml", ".noxroot/knowledge/INDEX.md"]);
const ROOT_INSTRUCTION = /^(?:AGENTS|CLAUDE|copilot-instructions)\.md$/i;
const MANIFESTS = new Set(["package.json", "pyproject.toml", "Cargo.toml", "go.mod"]);
const STOP_WORDS = new Set([
  "add",
  "and",
  "change",
  "changing",
  "can",
  "component",
  "components",
  "do",
  "existing",
  "fix",
  "for",
  "from",
  "has",
  "improve",
  "introduce",
  "into",
  "make",
  "modify",
  "modifying",
  "new",
  "not",
  "page",
  "pages",
  "pattern",
  "patterns",
  "reuse",
  "safe",
  "safety",
  "that",
  "the",
  "this",
  "top",
  "user",
  "users",
  "when",
  "with",
  "without",
]);
const TOKEN_ALIASES: Record<string, string> = {
  approved: "approve",
  approval: "approve",
  approvals: "approve",
  decisions: "decision",
  reviewer: "review",
  reviewers: "review",
  reviewing: "review",
  reviews: "review",
  tests: "test",
  testing: "test",
  verified: "verify",
  verification: "verify",
};

const SOURCE_EXTENSION = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|cs|rb|php)$/;
const TEST_PATH =
  /(?:^|\/)(?:__tests__|tests?|e2e|specs?)(?:\/|$)|\.(?:test|spec)\.|(?:^|\/)(?:test_[^/]+|[^/]+_(?:test|spec))\.(?:go|py|rb)$/;
const DOCUMENT_PATH = /(?:^|\/)(?:docs?|adr|adrs)(?:\/|$)|\.(?:md|mdx)$/;
const NON_AUTHORITATIVE_PATH =
  /(?:^|\/)(?:expected|fixtures?|golden|snapshots?|examples?|generated|vendor|cassettes?|recordings?|testdata|canary|payloads?)(?:\/|$)/i;

type Category = "entrypoint" | "manifest" | "source" | "test" | "document" | "other";

interface RankedCandidate {
  file: string;
  bytes: number;
  score: number;
  reasons: string[];
  category: Category;
  matchedTerms: Set<string>;
  pathMatchedTerms: Set<string>;
}

function isAlwaysContext(file: string): boolean {
  return ALWAYS_CONTEXT.has(file) || ROOT_INSTRUCTION.test(file);
}

function normalizeToken(value: string): string {
  let token = value.toLowerCase();
  const directAlias = TOKEN_ALIASES[token];
  if (directAlias) return directAlias;
  if (token.length > 4 && token.endsWith("ies")) token = `${token.slice(0, -3)}y`;
  else if (token.length > 4 && token.endsWith("s")) token = token.slice(0, -1);
  return TOKEN_ALIASES[token] ?? token;
}

function tokenList(value: string): string[] {
  return (
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  )
    .map(normalizeToken)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function tokens(value: string): string[] {
  return [...new Set(tokenList(value))];
}

function matchesGlob(pattern: string, file: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${escaped}$`).test(file);
}

function routeMatches(pattern: string, taskTerms: string[]): boolean {
  if (pattern === "**/*" || pattern === "**") return true;
  const routeTerms = tokens(pattern);
  return routeTerms.some((term) => taskTerms.includes(term));
}

function category(file: string): Category {
  if (isAlwaysContext(file)) return "entrypoint";
  if (MANIFESTS.has(path.posix.basename(file))) return "manifest";
  if (TEST_PATH.test(file)) return "test";
  if (SOURCE_EXTENSION.test(file)) return "source";
  if (DOCUMENT_PATH.test(file)) return "document";
  return "other";
}

function fileStem(file: string): string {
  return path.posix
    .basename(file)
    .replace(/\.(?:test|spec)(?=\.)/i, "")
    .replace(/\.[^.]+$/, "");
}

function baseScore(file: string, taskTerms: string[], activeRouteIds: string[]): RankedCandidate {
  const reasons: string[] = [];
  const fileCategory = category(file);
  const segments = file.split("/").slice(0, -1).flatMap(tokens);
  const stemTerms = tokens(fileStem(file));
  const pathTerms = tokens(file);
  const lower = file.toLowerCase();
  const matchedTerms = new Set<string>();
  const pathMatchedTerms = new Set<string>();
  let score = 0;

  if (file === ".noxroot/knowledge/INDEX.md") {
    score += 92;
    reasons.push("progressive-disclosure knowledge index");
  } else if (ROOT_INSTRUCTION.test(file)) {
    score += 88;
    reasons.push("authoritative repository instructions");
  } else if (file === ".noxroot/config.yml") {
    score += 52;
    reasons.push("active Noxroot configuration");
  } else if (MANIFESTS.has(path.posix.basename(file))) {
    score += 28;
    reasons.push("authoritative project manifest");
  }

  for (const term of isAlwaysContext(file) ? [] : taskTerms) {
    if (stemTerms.includes(term)) {
      score += 50;
      matchedTerms.add(term);
      pathMatchedTerms.add(term);
      reasons.push(`basename matches task term “${term}”`);
    } else if (segments.includes(term)) {
      score += 38;
      matchedTerms.add(term);
      pathMatchedTerms.add(term);
      reasons.push(`directory matches task term “${term}”`);
    } else if (pathTerms.includes(term)) {
      score += 22;
      matchedTerms.add(term);
      pathMatchedTerms.add(term);
      reasons.push(`path token matches task term “${term}”`);
    } else if (lower.includes(term)) {
      score += 7;
      matchedTerms.add(term);
      pathMatchedTerms.add(term);
      reasons.push(`path substring matches task term “${term}”`);
    }
  }

  if (fileCategory === "source") score += 4;
  if (fileCategory === "test") score += 3;
  if (file.startsWith(".noxroot/knowledge/")) score += 6;
  if (activeRouteIds.length > 0) {
    reasons.push("matched an active context route");
    reasons.push(`eligible through route ${activeRouteIds.join(", ")}`);
  }
  if (NON_AUTHORITATIVE_PATH.test(file)) {
    score -= 45;
    reasons.push("fixture/example penalty");
  }
  const procedure = file.replaceAll("\\", "/");
  if (
    procedure.endsWith("/.noxroot/skills/product-ux-review/SKILL.md") ||
    procedure === ".noxroot/skills/product-ux-review/SKILL.md"
  ) {
    if (
      taskTerms.some((term) =>
        ["design", "hierarchy", "interaction", "mobile", "ux", "wording"].includes(term),
      )
    ) {
      score += 70;
      reasons.push("product/UX procedure matches the requested surface");
    }
  } else if (procedure.endsWith(".noxroot/skills/verify-change/SKILL.md")) {
    if (taskTerms.some((term) => ["check", "regression", "test", "verify"].includes(term))) {
      score += 70;
      reasons.push("verification procedure matches the requested outcome");
    }
  } else if (procedure.endsWith(".noxroot/skills/independent-review/SKILL.md")) {
    if (taskTerms.some((term) => ["auth", "review", "security"].includes(term))) {
      score += 70;
      reasons.push("independent-review procedure matches the requested risk");
    }
  }
  return {
    file,
    bytes: 0,
    score,
    reasons,
    category: fileCategory,
    matchedTerms,
    pathMatchedTerms,
  };
}

async function addContentRelevance(
  root: string,
  candidates: RankedCandidate[],
  taskTerms: string[],
): Promise<void> {
  let inspected = 0;
  let inspectedBytes = 0;
  const inspectable = candidates
    .filter((item) => ["source", "test", "document"].includes(item.category))
    .filter((item) => item.bytes <= MAX_INSPECTED_FILE_BYTES)
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file));
  for (const item of inspectable) {
    if (inspected >= MAX_CONTENT_INSPECTIONS || inspectedBytes + item.bytes > MAX_CONTENT_BYTES)
      break;
    inspected += 1;
    inspectedBytes += item.bytes;
    let source: string;
    try {
      source = await readFile(resolveWithin(root, item.file), "utf8");
    } catch {
      continue;
    }
    const sourceTerms = tokenList(source);
    const matches = taskTerms.filter((term) => sourceTerms.includes(term));
    if (matches.length > 0) {
      item.score += Math.min(
        120,
        matches.reduce(
          (total, term) =>
            total + Math.min(4, sourceTerms.filter((token) => token === term).length) * 6,
          0,
        ),
      );
      for (const match of matches) item.matchedTerms.add(match);
      item.reasons.push(
        `content contains task term${matches.length === 1 ? "" : "s"} ${matches.map((term) => `“${term}”`).join(", ")}`,
      );
    }
    const sourceText = ` ${sourceTerms.join(" ")} `;
    const phraseMatches = taskTerms
      .slice(0, -1)
      .map((term, index) => `${term} ${taskTerms[index + 1]}`)
      .filter((phrase) => sourceText.includes(` ${phrase} `));
    if (phraseMatches.length > 0) {
      item.score += Math.min(48, phraseMatches.length * 24);
      item.reasons.push(
        `content matches task phrase${phraseMatches.length === 1 ? "" : "s"} ${phraseMatches.map((phrase) => `“${phrase}”`).join(", ")}`,
      );
    }
  }
  for (const item of candidates) {
    if (item.matchedTerms.size > 1) {
      item.score += (item.matchedTerms.size - 1) * 12;
      item.reasons.push(`matches ${item.matchedTerms.size} distinct task terms`);
    }
  }
}

function addAdjacency(candidates: RankedCandidate[]): void {
  const relevant = candidates.filter((item) => item.score >= 20);
  for (const item of candidates) {
    if (item.category !== "source" && item.category !== "test") continue;
    const stem = normalizeToken(fileStem(item.file));
    const counterpart = relevant.find(
      (candidate) =>
        candidate.file !== item.file &&
        candidate.category === (item.category === "source" ? "test" : "source") &&
        (normalizeToken(fileStem(candidate.file)) === stem ||
          tokens(candidate.file).includes(stem) ||
          tokens(item.file).includes(normalizeToken(fileStem(candidate.file)))),
    );
    if (counterpart) {
      item.score += 34;
      item.reasons.push(`source/test counterpart of ${counterpart.file}`);
    }
  }
}

function approvedCommands(
  config: Awaited<ReturnType<typeof loadVerification>>,
  relevantPaths: string[],
  reused: CandidateCommand[] = [],
): CandidateCommand[] {
  return (config?.commands ?? reused)
    .filter(
      (command) =>
        relevantPaths.length === 0 ||
        command.appliesTo.some((pattern) =>
          relevantPaths.some((relevantPath) => matchesGlob(pattern, relevantPath)),
        ),
    )
    .map((command) => ({
      id: command.id,
      executable: command.executable,
      args: command.args,
      cwd: command.cwd,
      source: "source" in command ? command.source : ".noxroot/verification.yml",
      appliesTo: command.appliesTo,
    }));
}

export async function buildContext(task: string, root = process.cwd()): Promise<ContextPackage> {
  const canonicalRoot = path.resolve(root);
  const config = await loadConfig(canonicalRoot);
  const profile = await scanRepository(canonicalRoot, {
    sensitivePaths: config?.sensitivePaths ?? [],
  });
  const adoption = await inspectRepositoryAdoption(profile);
  const routes = await loadRoutes(canonicalRoot);
  const verification = await loadVerification(canonicalRoot);
  const budget = config?.context.budgetBytes ?? DEFAULT_CONTEXT_BUDGET;
  const intent = parseTaskIntent(task);
  const taskTerms = tokens(relevantIntentText(intent));
  const projectAreaTerms = new Set(
    profile.files
      .filter((file) => MANIFESTS.has(path.posix.basename(file)))
      .map((file) => path.posix.dirname(file).split("/")[0])
      .filter((value): value is string => Boolean(value) && value !== ".")
      .flatMap(tokens),
  );
  const rankingTerms = taskTerms.filter((term) => !projectAreaTerms.has(term));
  const contentTerms = rankingTerms.filter(
    (term) => !["check", "regression", "test", "verify"].includes(term),
  );
  const excludedPathTerms = new Set(tokens(intent.explicitExclusions.join(" ")));
  const artifactPathsRequested = taskTerms.some((term) =>
    [
      "canary",
      "cassette",
      "example",
      "expected",
      "fixture",
      "golden",
      "payload",
      "recording",
      "sample",
      "snapshot",
      "testdata",
    ].includes(term),
  );
  const activeRoutes = (routes?.routes ?? []).filter((route) =>
    route.match.some((pattern) => routeMatches(pattern, taskTerms)),
  );
  const routedExcludes = activeRoutes.flatMap((route) => route.exclude);
  const routeIncludesFor = (file: string): string[] =>
    activeRoutes
      .filter((route) => route.include.some((pattern) => matchesGlob(pattern, file)))
      .map((route) => route.id);

  const outsidePool: Array<{ path: string; reason: string }> = [];
  const scopeExcluded: Array<{ path: string; reason: string }> = [];
  const candidates: RankedCandidate[] = [];
  for (const file of profile.files) {
    if (profile.suspectedSecrets.includes(file)) continue;
    if (NON_AUTHORITATIVE_PATH.test(file) && !artifactPathsRequested) {
      if (scopeExcluded.length < 10) {
        scopeExcluded.push({
          path: file,
          reason: "fixture, example, or recorded artifact outside the requested task",
        });
      }
      continue;
    }
    if (routedExcludes.some((pattern) => matchesGlob(pattern, file))) continue;
    if (tokens(file).some((term) => excludedPathTerms.has(term))) {
      if (scopeExcluded.length < 10) {
        scopeExcluded.push({ path: file, reason: "matches an explicit task exclusion" });
      }
      continue;
    }
    const activeRouteIds = routeIncludesFor(file);
    const fixed = isAlwaysContext(file) || MANIFESTS.has(path.posix.basename(file));
    if (activeRoutes.length > 0 && !fixed && activeRouteIds.length === 0) {
      if (outsidePool.length < 10) {
        outsidePool.push({ path: file, reason: "outside the active route candidate pool" });
      }
      continue;
    }
    const candidate = baseScore(file, rankingTerms, activeRouteIds);
    candidate.bytes = profile.fileSizes[file] ?? 0;
    if (adoption.referencedPaths.includes(file)) {
      candidate.score += 26;
      candidate.reasons.push("explicitly referenced by repository instructions");
    }
    candidates.push(candidate);
  }

  await addContentRelevance(canonicalRoot, candidates, contentTerms);
  addAdjacency(candidates);
  candidates.sort((left, right) => right.score - left.score || left.file.localeCompare(right.file));

  const selectionFileLimit = Math.min(8_000, Math.floor(budget * 0.55));
  const directlyMatchedOwner = (item: RankedCandidate): boolean =>
    item.category === "source" &&
    item.reasons.some((reason) => reason.startsWith("basename matches task term"));
  const fitsSelection = (item: RankedCandidate): boolean =>
    item.category === "entrypoint"
      ? item.bytes <= Math.min(selectionFileLimit, Math.floor(budget * 0.4))
      : item.bytes <= selectionFileLimit || (item.bytes <= budget && directlyMatchedOwner(item));
  const topOwner = candidates.find(
    (item) =>
      item.category === "source" &&
      item.matchedTerms.size > 0 &&
      item.score >= 20 &&
      fitsSelection(item),
  );
  const topPathOwners = rankingTerms
    .map((term) =>
      candidates.find(
        (item) =>
          item.category === "source" &&
          item.pathMatchedTerms.has(term) &&
          item.score >= 20 &&
          fitsSelection(item),
      ),
    )
    .filter((item): item is RankedCandidate => item !== undefined)
    .filter(
      (item, index, all) => all.findIndex((candidate) => candidate.file === item.file) === index,
    )
    .slice(0, 3);
  const topTest = candidates.find(
    (item) =>
      item.category === "test" &&
      item.matchedTerms.size > 0 &&
      item.score >= 20 &&
      fitsSelection(item),
  );
  const topProcedure = candidates.find(
    (item) => item.file.startsWith(".noxroot/skills/") && item.score >= 20 && fitsSelection(item),
  );
  const topDocument = candidates.find(
    (item) =>
      item.category === "document" &&
      !isAlwaysContext(item.file) &&
      item.matchedTerms.size > 0 &&
      item.score >= 20 &&
      fitsSelection(item),
  );
  const priority = [
    topOwner,
    ...topPathOwners,
    topProcedure,
    ...candidates.filter((item) => isAlwaysContext(item.file)),
    topTest,
    topDocument,
  ]
    .filter((item): item is RankedCandidate => item !== undefined)
    .filter(
      (item, index, all) => all.findIndex((candidate) => candidate.file === item.file) === index,
    );
  const selectionOrder = [...priority, ...candidates].filter(
    (item, index, all) => all.findIndex((candidate) => candidate.file === item.file) === index,
  );
  const priorityPaths = new Set(priority.map((item) => item.file));
  const directPathMatch = {
    source: candidates.some(
      (item) => item.category === "source" && item.pathMatchedTerms.size > 0 && item.score >= 20,
    ),
    test: candidates.some(
      (item) => item.category === "test" && item.pathMatchedTerms.size > 0 && item.score >= 20,
    ),
  };
  const curatedTargetBytes = Math.floor(budget * 0.85);

  const categoryCaps: Record<Category, number> = {
    entrypoint: 3,
    manifest: 2,
    source: 8,
    test: 6,
    document: 4,
    other: 2,
  };
  const categoryCounts: Record<Category, number> = {
    entrypoint: 0,
    manifest: 0,
    source: 0,
    test: 0,
    document: 0,
    other: 0,
  };
  const selected: ContextSelection[] = [];
  const excluded: Array<{ path: string; reason: string }> = [...scopeExcluded, ...outsidePool];
  let selectedBytes = 0;
  for (const item of selectionOrder) {
    const adjacentToPriority = item.reasons.some((reason) => {
      const match = /^source\/test counterpart of (.+)$/.exec(reason);
      return Boolean(match?.[1] && priorityPaths.has(match[1]));
    });
    if (!fitsSelection(item)) {
      if (excluded.length < 20) excluded.push({ path: item.file, reason: "per-file context cap" });
      continue;
    }
    if (
      (item.category === "source" || item.category === "test") &&
      item.matchedTerms.size === 0 &&
      !adjacentToPriority
    ) {
      if (excluded.length < 20)
        excluded.push({ path: item.file, reason: "insufficient direct task relevance" });
      continue;
    }
    if (
      (item.category === "source" || item.category === "test") &&
      directPathMatch[item.category] &&
      item.pathMatchedTerms.size === 0 &&
      !adjacentToPriority
    ) {
      if (excluded.length < 20) {
        excluded.push({ path: item.file, reason: "weaker than a direct task-path match" });
      }
      continue;
    }
    if (item.score < 10 && !isAlwaysContext(item.file)) {
      if (excluded.length < 20)
        excluded.push({ path: item.file, reason: "insufficient task relevance" });
      continue;
    }
    if (selected.length >= MAX_SELECTED_FILES) {
      if (excluded.length < 20)
        excluded.push({ path: item.file, reason: "selected-file count cap" });
      continue;
    }
    if (categoryCounts[item.category] >= categoryCaps[item.category]) {
      if (excluded.length < 20)
        excluded.push({ path: item.file, reason: `${item.category} category cap` });
      continue;
    }
    if (selectedBytes + item.bytes > budget) {
      if (excluded.length < 20) excluded.push({ path: item.file, reason: "context byte budget" });
      continue;
    }
    if (!priorityPaths.has(item.file) && selectedBytes + item.bytes > curatedTargetBytes) {
      if (excluded.length < 20)
        excluded.push({ path: item.file, reason: "curated context target" });
      continue;
    }
    selected.push({
      path: item.file,
      bytes: item.bytes,
      estimatedTokens: Math.ceil(item.bytes / 4),
      reasons: [
        ...new Set(item.reasons.length ? item.reasons : ["selected by bounded relevance ranking"]),
      ],
    });
    selectedBytes += item.bytes;
    categoryCounts[item.category] += 1;
  }

  const selectedSet = new Set(selected.map((item) => item.path));
  const likelyOwningSource = candidates
    .filter(
      (item) =>
        item.category === "source" &&
        (selectedSet.has(item.file) || (item.pathMatchedTerms.size > 0 && item.score >= 20)),
    )
    .slice(0, 5)
    .map((item) => item.file);
  const likelyTests = candidates
    .filter(
      (item) =>
        item.category === "test" &&
        (selectedSet.has(item.file) || (item.pathMatchedTerms.size > 0 && item.score >= 20)),
    )
    .slice(0, 5)
    .map((item) => item.file);
  const relevantPaths = [...likelyOwningSource, ...likelyTests];
  const reusedVerification =
    !verification && config?.modules.includes("verification") ? adoption.verificationWrappers : [];
  const requiredVerification = approvedCommands(verification, relevantPaths, reusedVerification);
  const conflicts = profile.evidence
    .filter((item) => item.status === "conflicting")
    .map((item) => item.claim);
  const unknowns = [
    ...(likelyOwningSource.length ? [] : ["Owning source path"]),
    ...(likelyTests.length ? [] : ["Directly related test path"]),
    ...(requiredVerification.length ? [] : ["Applicable approved verification command"]),
  ];
  const instructionEntrypoints = profile.files.filter((file) => ROOT_INSTRUCTION.test(file));
  const confidence: ContextPackage["confidence"] =
    likelyOwningSource.length > 0 &&
    likelyTests.length > 0 &&
    requiredVerification.length > 0 &&
    conflicts.length === 0
      ? "high"
      : likelyOwningSource.length > 0
        ? "partial"
        : "insufficient";

  return {
    task,
    interpretation:
      intent.requiredOutcomes[0] ?? "Inspect the repository for the requested local change.",
    intent,
    confidence,
    repositoryFileCount: profile.files.length,
    eligibleCandidateFiles: candidates.length,
    applicableAreas: [
      ...new Set(
        relevantPaths
          .map((file) => file.split("/")[0])
          .filter((value): value is string => Boolean(value)),
      ),
    ],
    selected,
    likelyOwningSource,
    likelyTests,
    constraints: [
      ...intent.explicitExclusions,
      ...instructionEntrypoints
        .filter((file) => !selectedSet.has(file))
        .map(
          (file) =>
            `Follow ${file} as the repository instruction entrypoint; load its relevant references selectively.`,
        ),
      ...selected
        .filter((item) => item.path.includes("knowledge/") || ROOT_INSTRUCTION.test(item.path))
        .map((item) => `Read ${item.path} before changing its routed surface.`),
    ],
    requiredVerification,
    conflicts,
    unknowns,
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
