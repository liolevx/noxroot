import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  CandidateCommand,
  Evidence,
  InspectionLimits,
  PackageManagerEvidence,
  RepositoryDocument,
  RepositoryProfile,
} from "../model.js";
import { isSuspectedSecret, normalizeRelative } from "../security/paths.js";

const DEFAULT_LIMITS: InspectionLimits = {
  maxFiles: 10_000,
  maxFileBytes: 256_000,
  maxContentBytes: 2_000_000,
  maxDepth: 16,
  maxDurationMs: 5_000,
};

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "target",
  "__pycache__",
  ".venv",
  "venv",
]);

const CONTENT_FILES = new Set([
  ".gitignore",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pnpm-workspace.yaml",
  "lerna.json",
  "nx.json",
  "turbo.json",
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "playwright.config.ts",
  "playwright.config.js",
  "next.config.ts",
  "next.config.js",
  "vite.config.ts",
  "vitest.config.ts",
]);

interface ScanOptions {
  limits?: Partial<InspectionLimits>;
  now?: () => number;
  sensitivePaths?: string[];
}

interface ContentMap {
  [path: string]: string;
}

interface IgnorePattern {
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
}

function classifyDocument(file: string): RepositoryDocument | undefined {
  const lower = file.toLowerCase();
  if (lower.startsWith(".noxroot/") || /(?:^|\/)(?:tests?\/)?fixtures?(?:\/|$)/.test(lower)) {
    return undefined;
  }
  const basename = path.posix.basename(lower);
  if (["agents.md", "claude.md", "copilot-instructions.md"].includes(basename)) {
    return { path: file, kind: "instructions", authoritative: true };
  }
  if (
    basename === "architecture.md" ||
    basename === "architecture.mdx" ||
    /(?:^|\/)docs?\/(?:system-)?architecture\.(?:md|mdx)$/.test(lower)
  ) {
    return { path: file, kind: "architecture", authoritative: true };
  }
  if (/^(?:product|requirements|product-requirements)\.(?:md|mdx)$/.test(basename)) {
    return { path: file, kind: "product", authoritative: true };
  }
  if (/^(?:ux|design-system|accessibility)\.(?:md|mdx)$/.test(basename)) {
    return { path: file, kind: "ux", authoritative: true };
  }
  if (/^(?:testing|test-strategy|quality)\.(?:md|mdx)$/.test(basename)) {
    return { path: file, kind: "testing", authoritative: true };
  }
  if (basename === "security.md") {
    return { path: file, kind: "security", authoritative: true };
  }
  if (/^(?:contributing|contribution)\.(?:md|mdx)$/.test(basename)) {
    return { path: file, kind: "contribution", authoritative: true };
  }
  if (/\.(?:md|mdx)$/.test(lower)) {
    return { path: file, kind: "ordinary", authoritative: false };
  }
  return undefined;
}

function globExpression(pattern: string): RegExp {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character?.replace(/[.+^${}()|[\]\\]/g, "\\$&") ?? "";
  }
  return new RegExp(`^(?:${expression})(?:/.*)?$`);
}

function parseIgnore(source: string): IgnorePattern[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const negated = line.startsWith("!");
      const raw = negated ? line.slice(1) : line;
      const directoryOnly = raw.endsWith("/");
      return {
        pattern: raw.replace(/^\//, "").replace(/\/$/, ""),
        negated,
        directoryOnly,
      };
    })
    .filter((entry) => entry.pattern.length > 0);
}

function ignoredByGit(relative: string, directory: boolean, patterns: IgnorePattern[]): boolean {
  let ignored = false;
  const segments = relative.split("/");
  for (const entry of patterns) {
    if (entry.directoryOnly && !directory && !relative.startsWith(`${entry.pattern}/`)) continue;
    const matches = entry.pattern.includes("/")
      ? globExpression(entry.pattern).test(relative)
      : segments.some((segment) => globExpression(entry.pattern).test(segment));
    if (matches) ignored = !entry.negated;
  }
  return ignored;
}

function matchesConfiguredPath(relative: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globExpression(pattern.replace(/^\.\//, "")).test(relative));
}

function commandFromScript(
  manager: NonNullable<PackageManagerEvidence["name"]>,
  id: string,
  scriptName = id,
): CandidateCommand {
  const args = manager === "yarn" ? [scriptName] : ["run", scriptName];
  return {
    id,
    executable: manager,
    args,
    cwd: ".",
    source: `package.json scripts.${scriptName}`,
    appliesTo: id === "test" ? ["src/**", "tests/**"] : ["**/*"],
  };
}

function packageManagerEvidence(
  files: string[],
  contents: ContentMap,
  manifest: { packageManager?: unknown } | undefined,
): PackageManagerEvidence {
  const declared =
    typeof manifest?.packageManager === "string"
      ? /^(npm|pnpm|yarn|bun)@[^\s]+$/i.exec(manifest.packageManager)?.[1]?.toLowerCase()
      : undefined;
  const lockEvidence = [
    { name: "npm" as const, files: ["package-lock.json", "npm-shrinkwrap.json"] },
    { name: "pnpm" as const, files: ["pnpm-lock.yaml"] },
    { name: "yarn" as const, files: ["yarn.lock"] },
    { name: "bun" as const, files: ["bun.lock", "bun.lockb"] },
  ]
    .map((candidate) => ({
      name: candidate.name,
      source: candidate.files.find((file) => files.includes(file)),
    }))
    .filter((candidate): candidate is { name: "npm" | "pnpm" | "yarn" | "bun"; source: string } =>
      Boolean(candidate.source),
    );
  if (typeof manifest?.packageManager === "string" && !declared) {
    return {
      status: "conflicting",
      sources: ["package.json packageManager"],
      detail: "packageManager must name npm, pnpm, yarn, or bun with a version.",
    };
  }
  if (declared) {
    const name = declared as "npm" | "pnpm" | "yarn" | "bun";
    const incompatibleLocks = lockEvidence.filter((candidate) => candidate.name !== name);
    if (incompatibleLocks.length > 0) {
      return {
        status: "conflicting",
        sources: [
          "package.json packageManager",
          ...lockEvidence.map((candidate) => candidate.source),
        ],
        detail: `Declared ${name} conflicts with ${incompatibleLocks.map((item) => item.source).join(", ")}.`,
      };
    }
    return {
      name,
      status: "confirmed",
      sources: ["package.json packageManager"],
      detail: `Declared package manager is ${name}.`,
    };
  }
  if (lockEvidence.length === 1) {
    const lock = lockEvidence[0]!;
    return {
      name: lock.name,
      status: "confirmed",
      sources: [lock.source],
      detail: `Unambiguous ${lock.name} lockfile.`,
    };
  }
  if (lockEvidence.length > 1) {
    return {
      status: "conflicting",
      sources: lockEvidence.map((candidate) => candidate.source),
      detail: "Multiple package-manager lockfiles are present.",
    };
  }
  const ciSources = Object.entries(contents).filter(([file]) =>
    file.startsWith(".github/workflows/"),
  );
  const ciManagers = ["npm", "pnpm", "yarn", "bun"].filter((manager) =>
    ciSources.some(([, source]) => new RegExp(`(?:^|\\s)${manager}(?:\\s|$)`, "m").test(source)),
  ) as Array<"npm" | "pnpm" | "yarn" | "bun">;
  if (ciManagers.length === 1) {
    const manager = ciManagers[0]!;
    return {
      name: manager,
      status: "inferred",
      sources: ciSources.map(([file]) => file),
      detail: `Existing CI consistently invokes ${manager}.`,
    };
  }
  if (ciManagers.length > 1) {
    return {
      status: "conflicting",
      sources: ciSources.map(([file]) => file),
      detail: `Existing CI invokes multiple package managers: ${ciManagers.join(", ")}.`,
    };
  }
  return {
    status: "unknown",
    sources: [],
    detail:
      "No packageManager declaration, unambiguous lockfile, or package-manager CI command was found.",
  };
}

function detectEvidence(
  files: string[],
  contents: ContentMap,
): {
  evidence: Evidence[];
  commands: CandidateCommand[];
} {
  const evidence: Evidence[] = [];
  const commands: CandidateCommand[] = [];
  const fileSet = new Set(files);
  const packageText = contents["package.json"];
  let packageManifest:
    | {
        packageManager?: unknown;
        scripts?: Record<string, string>;
        workspaces?: unknown;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      }
    | undefined;

  if (packageText) {
    try {
      const manifest = JSON.parse(packageText) as NonNullable<typeof packageManifest>;
      packageManifest = manifest;
      evidence.push({ status: "confirmed", claim: "Node.js project", sources: ["package.json"] });
      if (manifest.workspaces || fileSet.has("pnpm-workspace.yaml")) {
        evidence.push({
          status: "confirmed",
          claim: "JavaScript/TypeScript workspace",
          sources: manifest.workspaces ? ["package.json"] : ["pnpm-workspace.yaml"],
        });
      }
      const allDependencies = { ...manifest.dependencies, ...manifest.devDependencies };
      if (
        Object.keys(allDependencies).some(
          (name) => name.startsWith("@playwright/") || name === "playwright",
        )
      ) {
        evidence.push({
          status: "confirmed",
          claim: "Playwright browser verification",
          sources: ["package.json"],
        });
      }
    } catch {
      evidence.push({
        status: "conflicting",
        claim: "package.json is malformed",
        sources: ["package.json"],
      });
    }
  }

  const packageManager = packageManagerEvidence(files, contents, packageManifest);
  if (packageText) {
    evidence.push({
      status: packageManager.status,
      claim: packageManager.name
        ? `JavaScript package manager: ${packageManager.name}`
        : "JavaScript package manager",
      sources: packageManager.sources,
      detail: packageManager.detail,
    });
    if (
      packageManager.name &&
      packageManager.status !== "conflicting" &&
      packageManifest?.scripts
    ) {
      if (packageManifest.scripts["format:check"])
        commands.push(commandFromScript(packageManager.name, "format-check", "format:check"));
      for (const id of ["lint", "typecheck", "test", "build"]) {
        if (packageManifest.scripts[id]) commands.push(commandFromScript(packageManager.name, id));
      }
    }
  }

  if (fileSet.has("tsconfig.json") || files.some((file) => /\.(?:ts|tsx|mts|cts)$/.test(file))) {
    evidence.push({
      status: "confirmed",
      claim: "TypeScript source",
      sources: fileSet.has("tsconfig.json") ? ["tsconfig.json"] : ["source file extensions"],
    });
  }
  if (fileSet.has("pyproject.toml") || fileSet.has("requirements.txt")) {
    evidence.push({
      status: "confirmed",
      claim: "Python project",
      sources: fileSet.has("pyproject.toml") ? ["pyproject.toml"] : ["requirements.txt"],
    });
  }
  if (fileSet.has("Cargo.toml")) {
    evidence.push({ status: "confirmed", claim: "Rust project", sources: ["Cargo.toml"] });
  }
  if (fileSet.has("go.mod")) {
    evidence.push({ status: "confirmed", claim: "Go project", sources: ["go.mod"] });
  }
  const playwrightConfig = files.find((file) => /^playwright\.config\./.test(file));
  if (playwrightConfig && !evidence.some((item) => item.claim.startsWith("Playwright"))) {
    evidence.push({
      status: "confirmed",
      claim: "Playwright browser verification",
      sources: [playwrightConfig],
    });
  }
  if (fileSet.has("AGENTS.md")) {
    evidence.push({
      status: "confirmed",
      claim: "Existing coding-agent instructions",
      sources: ["AGENTS.md"],
    });
  }
  const ci = files.filter(
    (file) => file.startsWith(".github/workflows/") || file === ".gitlab-ci.yml",
  );
  if (ci.length > 0) {
    evidence.push({
      status: "confirmed",
      claim: "Continuous integration",
      sources: ci.slice(0, 5),
    });
  }
  return { evidence, commands };
}

export async function scanRepository(
  root: string,
  options: ScanOptions = {},
): Promise<RepositoryProfile> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const started = now();
  const files: string[] = [];
  const fileSizes: Record<string, number> = {};
  const contents: ContentMap = {};
  const suspectedSecrets: string[] = [];
  const blockedSymlinks: string[] = [];
  const incompleteReasons: string[] = [];
  let contentBytesRead = 0;
  let ignorePatterns: IgnorePattern[] = [];
  try {
    ignorePatterns = parseIgnore(await readFile(path.join(root, ".gitignore"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      incompleteReasons.push("could not read .gitignore");
    }
  }

  const queue: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: root, relative: "", depth: 0 },
  ];

  while (queue.length > 0) {
    if (now() - started > limits.maxDurationMs) {
      incompleteReasons.push(`time limit reached (${limits.maxDurationMs}ms)`);
      break;
    }
    if (files.length >= limits.maxFiles) {
      incompleteReasons.push(`file limit reached (${limits.maxFiles})`);
      break;
    }
    const current = queue.shift();
    if (!current) break;
    let entries;
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
    } catch (error) {
      incompleteReasons.push(
        `could not read ${current.relative || "."}: ${(error as NodeJS.ErrnoException).code ?? "error"}`,
      );
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= limits.maxFiles) {
        incompleteReasons.push(`file limit reached (${limits.maxFiles})`);
        break;
      }
      const relative = normalizeRelative(path.join(current.relative, entry.name));
      const absolute = path.join(current.absolute, entry.name);
      if (
        entry.name !== ".gitignore" &&
        ignoredByGit(relative, entry.isDirectory(), ignorePatterns)
      ) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        blockedSymlinks.push(relative);
        continue;
      }
      if (matchesConfiguredPath(relative, options.sensitivePaths ?? [])) {
        suspectedSecrets.push(entry.isDirectory() ? `${relative}/` : relative);
        continue;
      }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        if (current.depth + 1 > limits.maxDepth) {
          incompleteReasons.push(`depth limit reached at ${relative}`);
          continue;
        }
        queue.push({ absolute, relative, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      let size: number;
      try {
        size = (await stat(absolute)).size;
      } catch {
        continue;
      }
      files.push(relative);
      fileSizes[relative] = size;
      if (isSuspectedSecret(relative)) {
        suspectedSecrets.push(relative);
        continue;
      }
      if (
        size <= limits.maxFileBytes &&
        contentBytesRead + size <= limits.maxContentBytes &&
        (CONTENT_FILES.has(relative) ||
          CONTENT_FILES.has(entry.name) ||
          /^\.github\/workflows\/.*\.ya?ml$/i.test(relative))
      ) {
        try {
          contents[relative] = await readFile(absolute, "utf8");
          contentBytesRead += size;
        } catch {
          // Binary or concurrently removed files remain filename-only evidence.
        }
      }
    }
  }

  files.sort();
  suspectedSecrets.sort();
  blockedSymlinks.sort();
  const git = await lstat(path.join(root, ".git"))
    .then((gitStat) => gitStat.isDirectory() || gitStat.isFile())
    .catch(() => false);
  const { evidence, commands } = detectEvidence(files, contents);
  let packageManifest: { packageManager?: unknown } | undefined;
  try {
    packageManifest = contents["package.json"]
      ? (JSON.parse(contents["package.json"]) as { packageManager?: unknown })
      : undefined;
  } catch {
    packageManifest = undefined;
  }
  const packageManager = packageManagerEvidence(files, contents, packageManifest);
  const documents = files
    .map(classifyDocument)
    .filter((document): document is RepositoryDocument => document !== undefined);
  for (const kind of [
    "architecture",
    "product",
    "ux",
    "testing",
    "security",
    "contribution",
  ] as const) {
    const matches = documents.filter((document) => document.kind === kind);
    if (matches.length > 0) {
      evidence.push({
        status: kind === "architecture" && matches.length > 1 ? "conflicting" : "confirmed",
        claim:
          kind === "architecture" && matches.length > 1
            ? "Multiple architecture documents require reconciliation"
            : `Existing ${kind} documentation`,
        sources: matches.map((document) => document.path).slice(0, 10),
      });
    }
  }
  if (git) {
    evidence.unshift({ status: "confirmed", claim: "Git repository", sources: [".git"] });
    evidence.push({
      status: "unknown",
      claim: "Git worktree cleanliness",
      sources: [".git"],
      detail: "Preview does not execute Git commands.",
    });
  }
  const instructionFiles = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"].filter(
    (file) => files.includes(file),
  );
  if (instructionFiles.length > 1) {
    evidence.push({
      status: "conflicting",
      claim: "Multiple root agent instruction sources require reconciliation",
      sources: instructionFiles,
      detail: "Noxroot does not silently choose one vendor instruction file as authoritative.",
    });
  }
  const applicationFiles = files.filter(
    (file) =>
      !file.startsWith(".noxroot/") &&
      !["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"].includes(file),
  );
  const empty = applicationFiles.length === 0;
  if (empty) {
    evidence.push({
      status: "unknown",
      claim: "Application architecture",
      sources: [],
      detail: "No application files were found.",
    });
  }

  return {
    root,
    empty,
    git,
    files,
    fileSizes,
    evidence,
    suspectedSecrets,
    blockedSymlinks,
    candidateCommands: commands,
    documents,
    packageManager,
    stats: {
      filesVisited: files.length,
      contentBytesRead,
      durationMs: Math.max(0, now() - started),
      incompleteReasons: [...new Set(incompleteReasons)],
    },
  };
}
