import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
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
    /(?:^|\/)docs?\/(?:system-)?architecture\.(?:md|mdx)$/.test(lower) ||
    /(?:^|\/)architecture\/readme\.(?:md|mdx)$/.test(lower) ||
    (/(?:^|\/)architecture\//.test(lower) &&
      /^(?:ai|backend|contracts|data-coverage|frontend|infrastructure)\.(?:md|mdx)$/.test(basename))
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
  cwd = ".",
  manifestPath = "package.json",
  files: string[] = [],
): CandidateCommand {
  const args = manager === "yarn" ? [scriptName] : ["run", scriptName];
  const scope = cwd === "." ? "" : `${slug(cwd)}-`;
  return {
    id: `${scope}${id}`,
    executable: manager,
    args,
    cwd,
    source: `${manifestPath} scripts.${scriptName}`,
    appliesTo: cwd === "." ? (id === "test" ? rootTestScope(files) : ["**/*"]) : [`${cwd}/**`],
  };
}

function rootTestScope(files: string[]): string[] {
  const sourceDirectories = new Set<string>();
  const rootExtensions = new Set<string>();
  for (const file of files) {
    const extension = /\.([cm]?[jt]sx?|vue|svelte|py|go|rs)$/i.exec(file)?.[1]?.toLowerCase();
    if (!extension) continue;
    const separator = file.indexOf("/");
    if (separator === -1) rootExtensions.add(`*.${extension}`);
    else sourceDirectories.add(`${file.slice(0, separator)}/**`);
  }
  const inferred = [...sourceDirectories].sort().concat([...rootExtensions].sort());
  return inferred.length > 0 ? [...inferred, "package.json"] : ["**/*"];
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function packageManagerEvidence(
  files: string[],
  contents: ContentMap,
  manifest: { packageManager?: unknown } | undefined,
  directory = ".",
  manifestPath = "package.json",
): PackageManagerEvidence {
  const located = (name: string): string => (directory === "." ? name : `${directory}/${name}`);
  const declarationSource = `${manifestPath} packageManager`;
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
      source: candidate.files.map(located).find((file) => files.includes(file)),
    }))
    .filter((candidate): candidate is { name: "npm" | "pnpm" | "yarn" | "bun"; source: string } =>
      Boolean(candidate.source),
    );
  if (typeof manifest?.packageManager === "string" && !declared) {
    return {
      status: "conflicting",
      sources: [declarationSource],
      detail: "packageManager must name npm, pnpm, yarn, or bun with a version.",
    };
  }
  if (declared) {
    const name = declared as "npm" | "pnpm" | "yarn" | "bun";
    const incompatibleLocks = lockEvidence.filter((candidate) => candidate.name !== name);
    if (incompatibleLocks.length > 0) {
      return {
        status: "conflicting",
        sources: [declarationSource, ...lockEvidence.map((candidate) => candidate.source)],
        detail: `Declared ${name} conflicts with ${incompatibleLocks.map((item) => item.source).join(", ")}.`,
      };
    }
    return {
      name,
      status: "confirmed",
      sources: [declarationSource],
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

type PackageManifest = {
  packageManager?: unknown;
  scripts?: Record<string, string>;
  workspaces?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function commandTokens(source: string): string[] | undefined {
  const trimmed = source.trim();
  if (!trimmed || /[;&|><`$()#\r\n]/.test(trimmed)) return undefined;
  const matches = trimmed.match(/"[^"]*"|'[^']*'|\S+/g);
  return matches?.map((token) => token.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2"));
}

function workingDirectory(value: unknown, fallback = "."): string | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "string") return undefined;
  const cwd = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!cwd || /[`$*?{}\r\n]/.test(cwd) || path.posix.isAbsolute(cwd)) return undefined;
  if (cwd.split("/").includes("..")) return undefined;
  return cwd;
}

function ciVerificationCommands(contents: ContentMap): CandidateCommand[] {
  const commands: CandidateCommand[] = [];
  for (const [workflowPath, source] of Object.entries(contents)
    .filter(([file]) => /^\.github\/workflows\/.*\.ya?ml$/i.test(file))
    .sort(([left], [right]) => left.localeCompare(right))) {
    let workflow: unknown;
    try {
      workflow = parseYaml(source);
    } catch {
      continue;
    }
    const jobs = (workflow as { jobs?: unknown } | undefined)?.jobs;
    if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) continue;
    for (const [jobId, rawJob] of Object.entries(jobs)) {
      if (!rawJob || typeof rawJob !== "object" || Array.isArray(rawJob)) continue;
      const job = rawJob as {
        defaults?: { run?: { "working-directory"?: unknown } };
        steps?: unknown;
      };
      const cwd = workingDirectory(job.defaults?.run?.["working-directory"]);
      if (cwd === undefined) continue;
      if (!Array.isArray(job.steps)) continue;
      for (const [stepIndex, rawStep] of job.steps.entries()) {
        if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) continue;
        const step = rawStep as { name?: unknown; run?: unknown; "working-directory"?: unknown };
        if (typeof step.run !== "string") continue;
        const stepCwd = workingDirectory(step["working-directory"], cwd);
        if (stepCwd === undefined) continue;
        const tokens = commandTokens(step.run);
        if (!tokens || tokens.length < 2) continue;
        const [executable, ...args] = tokens;
        const supported =
          (executable === "uv" &&
            args[0] === "run" &&
            ["ruff", "mypy", "pytest"].includes(args[1] ?? "")) ||
          (executable === "python" && args[0] === "-m" && args[1] === "pytest") ||
          (executable === "cargo" && ["test", "check", "clippy"].includes(args[0] ?? "")) ||
          (executable === "go" && args[0] === "test");
        if (!supported || !executable) continue;
        const rawName = typeof step.name === "string" ? step.name : `${jobId}-${stepIndex + 1}`;
        const commandName =
          executable === "uv" ? args[1]! : executable === "python" ? args[1]! : args[0]!;
        const name =
          rawName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || commandName;
        const scope = stepCwd === "." ? "" : `${slug(stepCwd)}-`;
        commands.push({
          id: `${scope}${name}`,
          executable,
          args,
          cwd: stepCwd,
          source: `${workflowPath} jobs.${jobId}.steps[${stepIndex}].run`,
          appliesTo: stepCwd === "." ? ["**/*"] : [`${stepCwd}/**`],
        });
      }
    }
  }
  return commands;
}

function uniqueCommandIds(commands: CandidateCommand[]): CandidateCommand[] {
  const ordered = [...commands].sort(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      left.cwd.localeCompare(right.cwd) ||
      left.source.localeCompare(right.source),
  );
  const counts = new Map<string, number>();
  for (const command of ordered) counts.set(command.id, (counts.get(command.id) ?? 0) + 1);
  const used = new Set<string>();
  return ordered.map((command) => {
    let id = command.id;
    if ((counts.get(id) ?? 0) > 1) {
      const sourceScope = slug(command.source.split(/\s+(?:jobs|scripts)\./, 1)[0] ?? "check");
      const cwdScope = command.cwd === "." ? sourceScope : slug(command.cwd);
      if (cwdScope && !id.startsWith(`${cwdScope}-`)) id = `${cwdScope}-${id}`;
    }
    const base = id;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    return id === command.id ? command : { ...command, id };
  });
}

function scopedCommand(
  id: string,
  executable: string,
  args: string[],
  cwd: string,
  source: string,
): CandidateCommand {
  return {
    id: cwd === "." ? id : `${slug(cwd)}-${id}`,
    executable,
    args,
    cwd,
    source,
    appliesTo: cwd === "." ? ["**/*"] : [`${cwd}/**`],
  };
}

function nativeVerificationCommands(
  files: string[],
  contents: ContentMap,
  projectManifest: (file: string) => boolean,
): CandidateCommand[] {
  const commands: CandidateCommand[] = [];
  const fileSet = new Set(files);
  for (const manifest of files.filter(
    (file) => projectManifest(file) && path.posix.basename(file) === "pyproject.toml",
  )) {
    const source = contents[manifest];
    if (!source) continue;
    const cwd = path.posix.dirname(manifest);
    const located = (file: string): string => (cwd === "." ? file : `${cwd}/${file}`);
    const runner = fileSet.has(located("uv.lock")) ? ["uv", "run"] : ["python", "-m"];
    for (const tool of ["pytest", "ruff", "mypy"] as const) {
      if (!new RegExp(`^\\s*\\[tool\\.${tool}(?:\\.|])`, "m").test(source)) continue;
      const args =
        tool === "pytest"
          ? [...runner.slice(1), "pytest"]
          : tool === "ruff"
            ? [...runner.slice(1), "ruff", "check", "."]
            : [...runner.slice(1), "mypy", "."];
      commands.push(scopedCommand(tool, runner[0]!, args, cwd, `${manifest} [tool.${tool}]`));
    }
  }
  const cargoManifests = files.filter(
    (file) => projectManifest(file) && path.posix.basename(file) === "Cargo.toml",
  );
  const rootCargoWorkspace = /^\s*\[workspace(?:\.|])/m.test(contents["Cargo.toml"] ?? "");
  for (const manifest of rootCargoWorkspace
    ? cargoManifests.filter((file) => file === "Cargo.toml")
    : cargoManifests) {
    const cwd = path.posix.dirname(manifest);
    commands.push(scopedCommand("cargo-test", "cargo", ["test"], cwd, manifest));
    commands.push(scopedCommand("cargo-check", "cargo", ["check"], cwd, manifest));
  }
  for (const manifest of files.filter(
    (file) => projectManifest(file) && path.posix.basename(file) === "go.mod",
  )) {
    const cwd = path.posix.dirname(manifest);
    commands.push(scopedCommand("go-test", "go", ["test", "./..."], cwd, manifest));
  }
  return commands;
}

function aggregateEvidence(evidence: Evidence[]): Evidence[] {
  const grouped = new Map<string, Evidence[]>();
  for (const item of evidence) {
    const key = `${item.status}\0${item.claim}`;
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return [...grouped.values()].map((items) => {
    const first = items[0]!;
    const allSources = [...new Set(items.flatMap((item) => item.sources))].sort();
    const sources = allSources.slice(0, 12);
    const details = [...new Set(items.map((item) => item.detail).filter(Boolean))] as string[];
    const omittedSources = allSources.length - sources.length;
    const detailParts = [
      ...details.slice(0, 3),
      ...(details.length > 3 ? [`${details.length - 3} additional detail(s) omitted.`] : []),
      ...(omittedSources > 0 ? [`${omittedSources} additional source(s) omitted.`] : []),
    ];
    return {
      status: first.status,
      claim: first.claim,
      sources,
      ...(detailParts.length ? { detail: detailParts.join(" ") } : {}),
    };
  });
}

function detectEvidence(
  files: string[],
  contents: ContentMap,
): {
  evidence: Evidence[];
  commands: CandidateCommand[];
  packageManager: PackageManagerEvidence;
} {
  const evidence: Evidence[] = [];
  const commands: CandidateCommand[] = [];
  const fileSet = new Set(files);
  const packageManagers: Array<{ path: string; evidence: PackageManagerEvidence }> = [];
  const projectManifest = (file: string): boolean =>
    !/(?:^|\/)(?:tests?\/)?fixtures?(?:\/|$)|(?:^|\/)(?:examples?|samples?|playgrounds?|sandboxes?|benchmarks?|canary)(?:\/|$)/.test(
      file,
    );
  const packagePaths = files
    .filter((file) => path.posix.basename(file) === "package.json" && projectManifest(file))
    .sort();
  const collectionManifest = (file: string): boolean =>
    !/(?:^|\/)(?:tests?\/)?fixtures?(?:\/|$)|(?:^|\/)(?:playgrounds?|sandboxes?|benchmarks?|canary)(?:\/|$)/.test(
      file,
    );
  const projectManifests = files.filter(
    (file) =>
      ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"].includes(
        path.posix.basename(file),
      ) && collectionManifest(file),
  );
  const nestedManifests = projectManifests.filter((file) => file.includes("/"));
  const hasRootManifest = projectManifests.some((file) => !file.includes("/"));
  const exampleLikeManifests = nestedManifests.filter((file) =>
    /(?:^|\/)(?:examples?|demos?|starters?|templates?|tutorials?|lessons?|chapters?|chapter[-_]?\d+)(?:\/|$)/i.test(
      file,
    ),
  );
  const readme = (contents["README.md"] ?? "").replace(/\s+/g, " ");
  const collectionKind = String.raw`(?:course|workshop|tutorial (?:repository|series)|collection)`;
  const collectionUnits = String.raw`(?:examples?|lessons?|chapters?|starter (?:projects?|templates?)|sample projects?|final code)`;
  const readmeDescribesCollection =
    new RegExp(`\\b${collectionKind}\\b.{0,180}\\b${collectionUnits}\\b`, "i").test(readme) ||
    new RegExp(`\\b${collectionUnits}\\b.{0,180}\\b${collectionKind}\\b`, "i").test(readme);
  if (
    (!hasRootManifest || readmeDescribesCollection) &&
    nestedManifests.length >= 4 &&
    (exampleLikeManifests.length >= Math.ceil(nestedManifests.length / 2) ||
      readmeDescribesCollection)
  ) {
    evidence.push({
      status: "confirmed",
      claim: "Independent example collection",
      sources: nestedManifests.slice(0, 12),
      detail:
        "Choose one contained project as the Noxroot root; do not configure the collection as one application.",
    });
  }

  for (const packagePath of packagePaths) {
    const packageText = contents[packagePath];
    if (!packageText) continue;
    const directory = path.posix.dirname(packagePath);
    let packageManifest: PackageManifest | undefined;
    try {
      const manifest = JSON.parse(packageText) as PackageManifest;
      packageManifest = manifest;
      evidence.push({ status: "confirmed", claim: "Node.js project", sources: [packagePath] });
      if (
        manifest.workspaces ||
        fileSet.has(directory === "." ? "pnpm-workspace.yaml" : `${directory}/pnpm-workspace.yaml`)
      ) {
        evidence.push({
          status: "confirmed",
          claim: "JavaScript/TypeScript workspace",
          sources: manifest.workspaces
            ? [packagePath]
            : [directory === "." ? "pnpm-workspace.yaml" : `${directory}/pnpm-workspace.yaml`],
        });
      }
      const allDependencies = { ...manifest.dependencies, ...manifest.devDependencies };
      const userFacingDependencies = [
        "react",
        "next",
        "vue",
        "nuxt",
        "svelte",
        "solid-js",
        "@angular/core",
      ].filter((name) => name in allDependencies);
      const userFacingSources = files.filter(
        (file) =>
          (directory === "." || file.startsWith(`${directory}/`)) &&
          /\.(?:tsx|jsx|vue|svelte)$/.test(file) &&
          !/(?:^|\/)(?:tests?\/)?fixtures?(?:\/|$)/.test(file) &&
          /(?:^|\/)(?:src|app|pages|components)\//.test(file),
      );
      if (userFacingDependencies.length > 0 || userFacingSources.length > 0) {
        evidence.push({
          status: "confirmed",
          claim: "User-facing web application",
          sources: [
            ...(userFacingDependencies.length > 0 ? [packagePath] : []),
            ...userFacingSources.slice(0, 4),
          ],
        });
      }
      if (
        Object.keys(allDependencies).some(
          (name) => name.startsWith("@playwright/") || name === "playwright",
        )
      ) {
        evidence.push({
          status: "confirmed",
          claim: "Playwright browser verification",
          sources: [packagePath],
        });
      }
      const manager = packageManagerEvidence(files, contents, manifest, directory, packagePath);
      packageManagers.push({ path: packagePath, evidence: manager });
      evidence.push({
        status: manager.status,
        claim: manager.name
          ? `JavaScript package manager: ${manager.name}`
          : "JavaScript package manager",
        sources: manager.sources,
        detail: manager.detail,
      });
      if (manager.name && manager.status !== "conflicting" && packageManifest.scripts) {
        if (packageManifest.scripts["format:check"])
          commands.push(
            commandFromScript(manager.name, "format-check", "format:check", directory, packagePath),
          );
        const testCoversBuild = new RegExp(
          manager.name === "yarn"
            ? "(?:^|\\s)yarn\\s+build(?:\\s|$)"
            : `(?:^|\\s)${manager.name}\\s+run\\s+build(?:\\s|$)`,
        ).test(packageManifest.scripts.test ?? "");
        for (const id of ["lint", "typecheck", "test", "build"]) {
          if (id === "build" && testCoversBuild) continue;
          if (packageManifest.scripts[id])
            commands.push(commandFromScript(manager.name, id, id, directory, packagePath, files));
        }
      }
    } catch {
      evidence.push({
        status: "conflicting",
        claim: "package.json is malformed",
        sources: [packagePath],
      });
    }
  }

  const rootManager = packageManagers.find((item) => item.path === "package.json")?.evidence;
  const usableManagers = packageManagers.filter(
    (item) => item.evidence.name && item.evidence.status !== "conflicting",
  );
  const managerNames = [...new Set(usableManagers.map((item) => item.evidence.name))];
  const packageManager =
    rootManager ??
    (managerNames.length === 1
      ? {
          name: managerNames[0]!,
          status: "confirmed" as const,
          sources: usableManagers.flatMap((item) => item.evidence.sources),
          detail: `Detected ${managerNames[0]!} in ${usableManagers.map((item) => item.path).join(", ")}.`,
        }
      : packageManagerEvidence(files, contents, undefined));

  for (const command of ciVerificationCommands(contents)) {
    if (
      !commands.some(
        (candidate) =>
          candidate.executable === command.executable &&
          candidate.cwd === command.cwd &&
          JSON.stringify(candidate.args) === JSON.stringify(command.args),
      )
    ) {
      commands.push(command);
    }
  }
  for (const command of nativeVerificationCommands(files, contents, projectManifest)) {
    if (
      !commands.some(
        (candidate) =>
          candidate.executable === command.executable &&
          candidate.cwd === command.cwd &&
          JSON.stringify(candidate.args) === JSON.stringify(command.args),
      )
    ) {
      commands.push(command);
    }
  }

  if (fileSet.has("tsconfig.json") || files.some((file) => /\.(?:ts|tsx|mts|cts)$/.test(file))) {
    evidence.push({
      status: "confirmed",
      claim: "TypeScript source",
      sources: fileSet.has("tsconfig.json") ? ["tsconfig.json"] : ["source file extensions"],
    });
  }
  const pythonManifest = files.find(
    (file) =>
      projectManifest(file) &&
      ["pyproject.toml", "requirements.txt"].includes(path.posix.basename(file)),
  );
  if (pythonManifest) {
    evidence.push({
      status: "confirmed",
      claim: "Python project",
      sources: [pythonManifest],
    });
  }
  const rustManifest = files.find(
    (file) => projectManifest(file) && path.posix.basename(file) === "Cargo.toml",
  );
  if (rustManifest) {
    evidence.push({ status: "confirmed", claim: "Rust project", sources: [rustManifest] });
  }
  const goManifest = files.find(
    (file) => projectManifest(file) && path.posix.basename(file) === "go.mod",
  );
  if (goManifest) {
    evidence.push({ status: "confirmed", claim: "Go project", sources: [goManifest] });
  }
  const playwrightConfig = files.find(
    (file) => projectManifest(file) && /(?:^|\/)playwright\.config\./.test(file),
  );
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
  return {
    evidence: aggregateEvidence(evidence),
    commands: uniqueCommandIds(commands),
    packageManager,
  };
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
  const { evidence, commands, packageManager } = detectEvidence(files, contents);
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
      const competingArchitectureEntrypoints =
        kind === "architecture"
          ? matches.filter((document) =>
              /^architecture\.(?:md|mdx)$/i.test(path.posix.basename(document.path)),
            )
          : [];
      const architectureConflict = competingArchitectureEntrypoints.length > 1;
      evidence.push({
        status: architectureConflict ? "conflicting" : "confirmed",
        claim: architectureConflict
          ? "Multiple architecture documents require reconciliation"
          : `Existing ${kind} documentation`,
        sources: (architectureConflict ? competingArchitectureEntrypoints : matches)
          .map((document) => document.path)
          .slice(0, 10),
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
