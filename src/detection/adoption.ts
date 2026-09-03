import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  CandidateCommand,
  CapabilityAssessment,
  RepositoryDocument,
  RepositoryProfile,
} from "../model.js";
import { resolveWithin } from "../security/paths.js";

const MAX_REFERENCE_DEPTH = 3;
const MAX_REFERENCE_FILES = 80;
const MAX_REFERENCE_BYTES = 512_000;
const TEXT_REFERENCE = /\.(?:md|mdx|ya?ml)$/i;
const INSTRUCTION_NAME = /^(?:AGENTS|CLAUDE|copilot-instructions)\.md$/i;
const NON_PROJECT_SURFACE =
  /(?:^|\/)(?:tests?\/)?fixtures?(?:\/|$)|(?:^|\/)(?:examples?|samples?|playgrounds?|sandboxes?)(?:\/|$)/i;
const EXTERNAL_DEPENDENCY_REFERENCE = /(?:^|\/)(?:node_modules|\.venv|venv|site-packages)(?:\/|$)/i;

interface Reference {
  from: string;
  path: string;
  context: string;
}

interface Entrypoint {
  command: string;
  source?: string;
  declaredIn: string;
}

interface CoordinatorEvidence {
  name: string;
  declaredIn: string;
  evidence: string[];
}

interface AdjacentCapabilityEvidence {
  path: string;
  evidence: string[];
}

export interface AdoptionInspection {
  capabilities: CapabilityAssessment[];
  initializationAllowed: boolean;
  conflicts: string[];
  referencedDocuments: RepositoryDocument[];
  referencedPaths: string[];
  forwarding: Array<{ from: string; to: string }>;
  verificationWrappers: CandidateCommand[];
  verificationSkillPaths: string[];
  reviewSkillPaths: string[];
  productUxSkillPaths: string[];
}

function relativeTarget(from: string, raw: string): string | undefined {
  const withoutFragment = raw.trim().replace(/^<|>$/g, "").split(/[?#]/, 1)[0];
  if (
    !withoutFragment ||
    /^(?:[a-z]+:|#|\/|\\)/i.test(withoutFragment) ||
    withoutFragment.includes("\0")
  ) {
    return undefined;
  }
  const normalized = path.posix.normalize(
    path.posix.join(path.posix.dirname(from), withoutFragment.replaceAll("\\", "/")),
  );
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized.replace(/^\.\//, "");
}

function lineAt(source: string, index: number): string {
  const start = source.lastIndexOf("\n", index) + 1;
  const end = source.indexOf("\n", index);
  return source.slice(start, end === -1 ? source.length : end).trim();
}

function extractReferences(from: string, source: string): Array<Reference & { exists?: boolean }> {
  const found = new Map<string, Reference>();
  const capture = (raw: string, index: number): void => {
    const target = relativeTarget(from, raw);
    if (!target) return;
    found.set(`${target}\0${index}`, { from, path: target, context: lineAt(source, index) });
  };
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    capture(match[1] ?? "", match.index ?? 0);
  }
  for (const match of source.matchAll(/`([^`\r\n]+)`/g)) {
    const target = match[1] ?? "";
    if (/[\\/]/.test(target) || /\.(?:md|mdx|ya?ml)$/i.test(target)) {
      capture(target, match.index ?? 0);
    }
  }
  for (const match of source.matchAll(/(?:^|\s)@([A-Za-z0-9._/-]+\.(?:md|mdx))/gim)) {
    capture(match[1] ?? "", match.index ?? 0);
  }
  for (const match of source.matchAll(
    /(?:^|[\s("'])((?:\.\.?\/)?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:md|mdx|ya?ml))/gim,
  )) {
    capture(match[1] ?? "", match.index ?? 0);
  }
  return [...found.values()];
}

async function readableText(
  profile: RepositoryProfile,
  relative: string,
  maximum = 256_000,
): Promise<string | undefined> {
  const size = profile.fileSizes[relative];
  if (size === undefined || size > maximum || profile.suspectedSecrets.includes(relative)) {
    return undefined;
  }
  try {
    return await readFile(resolveWithin(profile.root, relative), "utf8");
  } catch {
    return undefined;
  }
}

function parsePythonEntrypoints(source: string, declaredIn: string): Entrypoint[] {
  const entries: Entrypoint[] = [];
  let active = false;
  for (const line of source.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)]\s*$/.exec(line)?.[1];
    if (section) {
      active = ["project.scripts", "tool.poetry.scripts"].includes(section);
      continue;
    }
    if (!active) continue;
    const match = /^\s*["']?([A-Za-z0-9._-]+)["']?\s*=\s*["']([^"']+)["']/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const moduleName = match[2].split(":", 1)[0];
    entries.push({
      command: match[1],
      ...(moduleName ? { source: `${moduleName.replaceAll(".", "/")}.py` } : {}),
      declaredIn,
    });
  }
  return entries;
}

async function entrypoints(profile: RepositoryProfile): Promise<Entrypoint[]> {
  const entries: Entrypoint[] = [];
  for (const manifest of profile.files.filter(
    (file) => path.posix.basename(file) === "pyproject.toml",
  )) {
    const source = await readableText(profile, manifest);
    if (source) entries.push(...parsePythonEntrypoints(source, manifest));
  }
  for (const manifest of profile.files.filter(
    (file) => path.posix.basename(file) === "package.json",
  )) {
    const source = await readableText(profile, manifest);
    if (!source) continue;
    try {
      const parsed = JSON.parse(source) as { bin?: string | Record<string, string> };
      if (typeof parsed.bin === "string") {
        const command = path.posix.basename(path.posix.dirname(manifest));
        entries.push({ command, source: parsed.bin, declaredIn: manifest });
      } else {
        for (const [command, target] of Object.entries(parsed.bin ?? {})) {
          const resolved = relativeTarget(manifest, target);
          entries.push({
            command,
            ...(resolved ? { source: resolved } : {}),
            declaredIn: manifest,
          });
        }
      }
    } catch {
      // Malformed manifests are already reported by the repository scanner.
    }
  }
  return entries;
}

function commandTokens(value: string): string[] | undefined {
  if (/[;&|><`$()\r\n]/.test(value)) return undefined;
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.length <= 8 ? tokens : undefined;
}

function documentedWrappers(
  sources: Map<string, string>,
  declared: Entrypoint[],
): CandidateCommand[] {
  const commands = new Map<string, CandidateCommand>();
  const declaredNames = new Set(declared.map((item) => item.command));
  for (const [sourcePath, source] of sources) {
    for (const match of source.matchAll(/`([^`\r\n]+)`/g)) {
      const tokens = commandTokens(match[1] ?? "");
      if (!tokens) continue;
      const declaredIndex = tokens.findIndex((token) => declaredNames.has(token));
      if (declaredIndex === -1) continue;
      const declaredName = tokens[declaredIndex]!;
      if (!/(?:check|verify|test|lint|build|eval)/i.test(`${declaredName} ${match[1]}`)) continue;
      const executable = tokens[0]!;
      const args = tokens.slice(1);
      const key = `${executable}\0${args.join("\0")}`;
      commands.set(key, {
        id: declaredName,
        executable,
        args,
        cwd: ".",
        source: sourcePath,
        appliesTo: ["**/*"],
      });
    }
  }
  return [...commands.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function skillMetadata(source: string): { name?: string; description?: string } {
  const frontmatter = /^---\r?\n([\s\S]+?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
  if (!frontmatter) return {};
  try {
    const parsed = parseYaml(frontmatter) as { name?: unknown; description?: unknown };
    return {
      ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
      ...(typeof parsed.description === "string" ? { description: parsed.description } : {}),
    };
  } catch {
    return {};
  }
}

const COORDINATOR_BEHAVIORS = [
  {
    label: "Git/worktree control",
    patterns: [
      /\b(?:create|manage|control|own|prepare|checkout|commit|merge)\w*\b.{0,100}\b(?:git|branches?|worktrees?|commits?|merges?|pull requests?)\b/i,
      /\b(?:git|branches?|worktrees?|commits?|merges?|pull requests?)\b.{0,100}\b(?:create|manage|control|own|prepare|checkout|commit|merge)\w*\b/i,
    ],
  },
  {
    label: "code-change execution",
    patterns: [
      /\b(?:invoke|run|spawn|coordinate|dispatch|direct)\w*\b.{0,100}\b(?:coding|implementation)\s+(?:agents?|workers?)\b/i,
      /\b(?:agents?|workers?)\b.{0,100}\b(?:implement|edit|modify|write|change)\w*\b.{0,60}\b(?:code|repository)\b/i,
    ],
  },
  {
    label: "verification",
    patterns: [
      /\b(?:run|execute|select|perform|coordinate)\w*\b.{0,100}\b(?:verification|tests?|checks?|builds?|evals?)\b/i,
    ],
  },
  {
    label: "independent review",
    patterns: [
      /\b(?:invoke|run|request|perform|coordinate|require)\w*\b.{0,100}\b(?:independent\s+)?review(?:er|ers| cycle)?\b/i,
    ],
  },
] as const;

function declaredCoordinatorBehaviors(source: string): string[] {
  const statements = source
    .replace(/\r?\n(?=\s*(?:[-*+]\s+|\d+[.)]\s+))/g, ". ")
    .replace(/\r?\n/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter(
      (statement) =>
        !/\b(?:does not|doesn't|do not|don't|never|without|cannot|can't|will not|won't)\b/i.test(
          statement,
        ),
    );
  return COORDINATOR_BEHAVIORS.filter((behavior) =>
    statements.some((statement) => behavior.patterns.some((pattern) => pattern.test(statement))),
  ).map((behavior) => behavior.label);
}

function implementationCoordinatorBehaviors(source: string): string[] {
  return [
    { label: "Git/worktree control", match: /\b(?:git|worktree|commit|merge|pull request)\b/i },
    {
      label: "code-change execution",
      match: /\b(?:worker|implementation|code changes?|owned.paths|writable)\b/i,
    },
    { label: "verification", match: /\bverif(?:y|ication|ied)\b/i },
    { label: "independent review", match: /\breviewer?|review cycle\b/i },
  ]
    .filter((marker) => marker.match.test(source))
    .map((marker) => marker.label);
}

const ADJACENT_LEDGER_BEHAVIORS = [
  {
    label: "durable work state",
    match:
      /\b(?:coordination ledger|session journal|issue tracker|work log|append-only (?:event )?log)\b.{0,180}\b(?:records?|stores?|preserves?|tracks?|holds?|captures?)\b.{0,180}\b(?:state of the work|decisions?|open items?|unresolved items?|handoffs?|session notes?)\b|\brecords?\b.{0,120}\b(?:state of the work|decisions?|open items?|unresolved items?|handoffs?|session notes?)\b.{0,120}\b(?:local |shared |append-only (?:event )?)?log\b/i,
  },
  {
    label: "cross-session continuity",
    match: /\b(?:cross-session|across sessions?|new session|resume|resuming|handoff)\b/i,
  },
  {
    label: "coding-work coordination",
    match:
      /\bcoding\b.{0,24}\bagents?\b|\b(?:agent|session)\s+records?\s+(?:the\s+)?state of the work\b|\b(?:repository(?:-development)? (?:work|workflow)|development workflow|implementation work)\b/i,
  },
] as const;

function adjacentLedgerBehaviors(source: string): string[] {
  const normalized = source.replace(/\s+/g, " ");
  return ADJACENT_LEDGER_BEHAVIORS.filter((behavior) => behavior.match.test(normalized)).map(
    (behavior) => behavior.label,
  );
}

function assessment(
  id: CapabilityAssessment["id"],
  label: string,
  decision: CapabilityAssessment["decision"],
  evidence: string[] = [],
  missingEvidence: string[] = [],
): CapabilityAssessment {
  return { id, label, decision, evidence, missingEvidence };
}

export async function inspectRepositoryAdoption(
  profile: RepositoryProfile,
): Promise<AdoptionInspection> {
  const instructionFiles = profile.files.filter(
    (file) => INSTRUCTION_NAME.test(path.posix.basename(file)) && !NON_PROJECT_SURFACE.test(file),
  );
  const fileSet = new Set(profile.files);
  const sources = new Map<string, string>();
  const references: Reference[] = [];
  const missing: Reference[] = [];
  const narrativeRoots = [...instructionFiles, ...(fileSet.has("README.md") ? ["README.md"] : [])];
  const queue = narrativeRoots.map((file) => ({ file, depth: 0 }));
  const visited = new Set<string>();
  let bytes = 0;
  while (queue.length > 0 && visited.size < MAX_REFERENCE_FILES && bytes < MAX_REFERENCE_BYTES) {
    const next = queue.shift();
    if (!next || visited.has(next.file)) continue;
    visited.add(next.file);
    const source = await readableText(profile, next.file);
    if (source === undefined) continue;
    sources.set(next.file, source);
    bytes += Buffer.byteLength(source);
    for (const reference of extractReferences(next.file, source)) {
      if (fileSet.has(reference.path)) {
        references.push(reference);
        if (
          next.depth < MAX_REFERENCE_DEPTH &&
          (TEXT_REFERENCE.test(reference.path) ||
            path.posix.basename(reference.path) === "SKILL.md")
        ) {
          queue.push({ file: reference.path, depth: next.depth + 1 });
        }
      } else if (!EXTERNAL_DEPENDENCY_REFERENCE.test(reference.path)) {
        missing.push(reference);
      }
    }
  }

  const forwarding: Array<{ from: string; to: string }> = [];
  for (const file of instructionFiles) {
    const source = sources.get(file);
    if (!source || source.length > 400) continue;
    const targets = references.filter(
      (item) => item.from === file && INSTRUCTION_NAME.test(path.posix.basename(item.path)),
    );
    const containsIndependentDirective =
      /\b(?:do not|don't|must not|never|override|ignore|instead of|only follow)\b/i.test(source);
    if (targets.length === 1 && !containsIndependentDirective) {
      forwarding.push({ from: file, to: targets[0]!.path });
    }
  }

  const rootInstructions = instructionFiles.filter((file) => !file.includes("/"));
  const normalizedInstruction = (file: string): string =>
    (sources.get(file) ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const genuineInstructionConflict =
    rootInstructions.length > 1 &&
    !rootInstructions.every(
      (file, index, all) =>
        index === 0 ||
        normalizedInstruction(file) === normalizedInstruction(all[0]!) ||
        forwarding.some((item) => item.from === file && rootInstructions.includes(item.to)),
    );

  const referencedPaths = [...new Set(references.map((item) => item.path))].sort();
  const instructionSet = new Set(instructionFiles);
  const referencedDocuments = [
    ...new Set(
      references
        .filter(
          (item) =>
            instructionSet.has(item.from) &&
            /\.(?:md|mdx)$/i.test(item.path) &&
            !INSTRUCTION_NAME.test(path.posix.basename(item.path)),
        )
        .map((item) => item.path),
    ),
  ].map((file): RepositoryDocument => ({ path: file, kind: "ordinary", authoritative: true }));
  const routeReferences = references.filter(
    (item) =>
      /\broutes?\b/i.test(item.context) && !INSTRUCTION_NAME.test(path.posix.basename(item.path)),
  );
  const missingRouteReferences = missing.filter((item) => /\broutes?\b/i.test(item.context));
  const knowledgeReferences = references.filter(
    (item) =>
      /\b(?:architecture|conventions?|decisions?|knowledge|memory|product|quality|rules?)\b/i.test(
        item.context,
      ) &&
      /\.(?:md|mdx|ya?ml)$/i.test(item.path) &&
      !INSTRUCTION_NAME.test(path.posix.basename(item.path)) &&
      path.posix.basename(item.path) !== "SKILL.md",
  );
  const missingKnowledgeReferences = missing.filter((item) =>
    /\b(?:architecture|conventions?|decisions?|knowledge|memory|product|quality|rules?)\b/i.test(
      item.context,
    ),
  );

  const skillFiles = profile.files.filter(
    (file) => path.posix.basename(file) === "SKILL.md" && !NON_PROJECT_SURFACE.test(file),
  );
  const verificationSkillPaths: string[] = [];
  const reviewSkillPaths: string[] = [];
  const productUxSkillPaths: string[] = [];
  for (const skillPath of skillFiles) {
    const source = sources.get(skillPath) ?? (await readableText(profile, skillPath));
    if (!source) continue;
    const metadata = skillMetadata(source);
    const declaredPurpose = `${metadata.name ?? ""} ${metadata.description ?? ""}`;
    if (/(?:check|verify|verification|test)/i.test(declaredPurpose)) {
      verificationSkillPaths.push(skillPath);
      sources.set(skillPath, source);
    }
    if (
      /\b(?:review|reviewer)\b/i.test(declaredPurpose) &&
      /\b(?:repository|diff|change|code)\b/i.test(declaredPurpose) &&
      /\b(?:independent|independently|fresh-context|correctness|regression|security)\b/i.test(
        declaredPurpose,
      )
    ) {
      reviewSkillPaths.push(skillPath);
      sources.set(skillPath, source);
    }
    if (
      /\b(?:product|ux|usability|user-facing|interface)\b/i.test(declaredPurpose) &&
      /\b(?:review|check|quality)\b/i.test(declaredPurpose)
    ) {
      productUxSkillPaths.push(skillPath);
      sources.set(skillPath, source);
    }
  }

  const declaredEntrypoints = await entrypoints(profile);
  const verificationWrappers = documentedWrappers(sources, declaredEntrypoints);
  const noxrootConfigSource = fileSet.has(".noxroot/config.yml")
    ? await readableText(profile, ".noxroot/config.yml")
    : undefined;
  let noxrootOwnsOrchestration = false;
  if (noxrootConfigSource) {
    try {
      const parsed = parseYaml(noxrootConfigSource) as { modules?: unknown };
      noxrootOwnsOrchestration =
        Array.isArray(parsed.modules) && parsed.modules.includes("orchestration");
    } catch {
      // Malformed Noxroot configuration is reported by preview and doctor.
    }
  }
  const coordinators: CoordinatorEvidence[] = [];
  for (const entrypoint of declaredEntrypoints) {
    if (!entrypoint.source || !fileSet.has(entrypoint.source)) continue;
    const source = await readableText(profile, entrypoint.source);
    if (!source) continue;
    const markers = implementationCoordinatorBehaviors(source);
    if (markers.length === 4) {
      coordinators.push({
        name: entrypoint.command,
        declaredIn: entrypoint.declaredIn,
        evidence: markers,
      });
    }
  }
  const declaredBehaviorSurfaces = references.filter(
    (reference) => instructionSet.has(reference.from) && sources.has(reference.path),
  );
  for (const surface of declaredBehaviorSurfaces) {
    const source = sources.get(surface.path);
    if (!source) continue;
    const evidence = declaredCoordinatorBehaviors(source);
    if (evidence.length !== COORDINATOR_BEHAVIORS.length) continue;
    const key = `${surface.path}\0${surface.from}`;
    if (coordinators.some((item) => `${item.name}\0${item.declaredIn}` === key)) continue;
    coordinators.push({ name: surface.path, declaredIn: surface.from, evidence });
  }
  const adjacentCapabilities: AdjacentCapabilityEvidence[] = [];
  for (const [sourcePath, source] of sources) {
    if (NON_PROJECT_SURFACE.test(sourcePath)) continue;
    const evidence = adjacentLedgerBehaviors(source);
    if (evidence.length !== ADJACENT_LEDGER_BEHAVIORS.length) continue;
    adjacentCapabilities.push({ path: sourcePath, evidence });
  }

  const incomplete = profile.stats.incompleteReasons.length > 0;
  const projectCollection = profile.evidence.some(
    (item) => item.status === "confirmed" && item.claim === "Independent example collection",
  );
  const collectionGap = [
    "This repository contains independent examples. Select one project with --root before initializing.",
  ];
  const authoritativeKnowledge = profile.documents.filter(
    (item) => item.authoritative && item.kind !== "instructions",
  );
  const capabilities: CapabilityAssessment[] = [];
  capabilities.push(
    knowledgeReferences.length > 0 || authoritativeKnowledge.length > 0
      ? assessment(
          "project-knowledge",
          "Project knowledge",
          "reuse",
          [
            ...new Set([
              ...knowledgeReferences.map((item) => item.path),
              ...authoritativeKnowledge.map((item) => item.path),
            ]),
          ].sort(),
        )
      : missingKnowledgeReferences.length > 0 || incomplete
        ? assessment(
            "project-knowledge",
            "Project knowledge",
            "not-assessed",
            [],
            missingKnowledgeReferences.length
              ? missingKnowledgeReferences.map(
                  (item) => `Referenced path was not available: ${item.path}`,
                )
              : profile.stats.incompleteReasons,
          )
        : assessment("project-knowledge", "Project knowledge", "create"),
  );
  capabilities.push(
    projectCollection
      ? assessment("task-routes", "Task routes", "not-assessed", [], collectionGap)
      : routeReferences.length > 0 || fileSet.has(".noxroot/routes.yml")
        ? assessment(
            "task-routes",
            "Task routes",
            "reuse",
            [...new Set(routeReferences.map((item) => item.path))].sort(),
          )
        : profile.empty || missingRouteReferences.length > 0 || incomplete
          ? assessment(
              "task-routes",
              "Task routes",
              "not-assessed",
              [],
              profile.empty
                ? ["No repository source exists yet, so task routes cannot be assessed."]
                : missingRouteReferences.length
                  ? missingRouteReferences.map(
                      (item) => `Referenced path was not available: ${item.path}`,
                    )
                  : profile.stats.incompleteReasons,
            )
          : assessment("task-routes", "Task routes", "create"),
  );
  capabilities.push(
    projectCollection
      ? assessment("verification-policy", "Verification", "not-assessed", [], collectionGap)
      : verificationWrappers.length > 0 || fileSet.has(".noxroot/verification.yml")
        ? assessment(
            "verification-policy",
            "Verification",
            "reuse",
            verificationWrappers.length
              ? verificationWrappers.map((item) =>
                  `${item.executable} ${item.args.join(" ")} (${item.source})`.trim(),
                )
              : [".noxroot/verification.yml"],
          )
        : profile.candidateCommands.length > 0
          ? assessment("verification-policy", "Verification", "create")
          : assessment(
              "verification-policy",
              "Verification",
              "not-assessed",
              [],
              ["No authoritative verification wrapper or candidate checks were found."],
            ),
  );
  const verificationDecision = capabilities.at(-1)!.decision;
  capabilities.push(
    verificationSkillPaths.length > 0
      ? assessment(
          "verification-skill",
          "Verification skill",
          "reuse",
          verificationSkillPaths.sort(),
        )
      : verificationDecision === "not-assessed"
        ? assessment(
            "verification-skill",
            "Verification skill",
            "not-assessed",
            [],
            ["Verification behavior was not assessed."],
          )
        : assessment("verification-skill", "Verification skill", "create"),
  );
  capabilities.push(
    projectCollection
      ? assessment("task-orchestration", "Task orchestration", "not-assessed", [], collectionGap)
      : coordinators.length > 0
        ? assessment(
            "task-orchestration",
            "Task orchestration",
            "conflict",
            coordinators.map(
              ({ name, declaredIn, evidence }) => `${name} (${declaredIn}; ${evidence.join(", ")})`,
            ),
          )
        : noxrootOwnsOrchestration
          ? assessment("task-orchestration", "Task orchestration", "reuse", [".noxroot/config.yml"])
          : profile.empty || incomplete
            ? assessment(
                "task-orchestration",
                "Task orchestration",
                "not-assessed",
                [],
                profile.empty
                  ? ["No repository source exists yet, so task orchestration cannot be assessed."]
                  : profile.stats.incompleteReasons,
              )
            : assessment("task-orchestration", "Task orchestration", "create"),
  );
  if (adjacentCapabilities.length > 0) {
    capabilities.push(
      assessment(
        "coordination-ledger",
        "External work ledger",
        "adjacent",
        adjacentCapabilities.map(
          ({ path: sourcePath, evidence }) => `${sourcePath} (${evidence.join(", ")})`,
        ),
      ),
    );
  }
  const productDocuments = [
    ...references
      .filter(
        (item) =>
          /\b(?:product|ux|design)\b/i.test(`${item.context} ${item.path}`) &&
          !INSTRUCTION_NAME.test(path.posix.basename(item.path)) &&
          path.posix.basename(item.path) !== "SKILL.md",
      )
      .map((item) => item.path),
    ...profile.documents
      .filter((document) => document.kind === "product" || document.kind === "ux")
      .map((document) => document.path),
  ];
  const userFacing = profile.evidence.some((item) => item.claim === "User-facing web application");
  capabilities.push(
    productDocuments.length > 0 || productUxSkillPaths.length > 0
      ? assessment(
          "product-ux-guidance",
          "Product and UX guidance",
          "reuse",
          [...new Set([...productDocuments, ...productUxSkillPaths])].sort(),
        )
      : userFacing
        ? assessment("product-ux-guidance", "Product and UX guidance", "create")
        : assessment(
            "product-ux-guidance",
            "Product and UX guidance",
            "not-assessed",
            [],
            ["No user-facing product surface was detected."],
          ),
  );

  const conflicts = [
    ...(projectCollection ? collectionGap : []),
    ...(genuineInstructionConflict
      ? [
          `Multiple root agent instruction sources require reconciliation: ${rootInstructions.join(", ")}`,
        ]
      : []),
    ...coordinators.map(
      ({ name, evidence }) =>
        `Existing repository-development coordinator overlaps Noxroot orchestration: ${name} (${evidence.join(", ")})`,
    ),
  ];
  // A conflict blocks only the overlapping capability. Initialization remains safe when
  // Noxroot can install non-overlapping companion capabilities without changing authority.
  const initializationAllowed = !genuineInstructionConflict && !projectCollection;
  return {
    capabilities,
    initializationAllowed,
    conflicts,
    referencedDocuments,
    referencedPaths,
    forwarding,
    verificationWrappers,
    verificationSkillPaths,
    reviewSkillPaths,
    productUxSkillPaths,
  };
}
