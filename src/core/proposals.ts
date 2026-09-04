import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import type {
  CandidateCommand,
  CapabilityAssessment,
  CapabilityDecision,
  ModuleAssessment,
  ProposedFile,
  RepositoryDocument,
  RepositoryProfile,
} from "../model.js";
import type { AdoptionInspection } from "../detection/adoption.js";
import { cliCommand } from "../invocation.js";

const MANAGED_START = "<!-- noxroot:start -->";
const MANAGED_END = "<!-- noxroot:end -->";
type WorkflowMode = "full" | "companion" | "context-only";

function managedBlock(mode: WorkflowMode, hasKnowledgeIndex = true): string {
  const workflow =
    mode === "full"
      ? `For a code-changing task, run \`${cliCommand('start "<task>"')}\` before editing and \`${cliCommand("finish")}\` when the change is ready to check. A repeated start for the same active task continues its existing baseline. Do not start a task for questions, explanations, reviews, or other read-only work.

If start fails, stop before editing and report the error. If finish fails, do not report the task complete. Request only the access needed to retry; do not disable the sandbox or create a second task-state store.

For unfinished work, use \`${cliCommand("status")}\` before opening raw task records. Even when status lists an active task, repeat start with that task's text before resuming edits: status is read-only and does not check write access. Keep routine output brief; use \`--verbose\` or \`--json\` when supporting detail is needed.

When \`.noxroot/skills/\` exists, load only the task-relevant \`SKILL.md\`: verification for changed-code checks, independent review for fresh review, and product/UX review only for applicable user-facing work.`
      : mode === "companion"
        ? `The existing repository coordinator remains authoritative for code-changing work. Noxroot does not add a second task lifecycle, reviewer, or learning loop.

Use \`${cliCommand('context "<task>"')}\` when focused repository context would help and \`${cliCommand("verify --plan")}\` to inspect applicable approved checks. Follow the existing repository workflow for implementation, review, and durable learning.`
        : `Noxroot's task lifecycle is not enabled for this repository because the available project evidence is incomplete.

Use \`${cliCommand('context "<task>"')}\` when focused repository context would help and \`${cliCommand("verify --plan")}\` to inspect applicable approved checks. Do not claim verification until the repository provides an approved check.`;
  const knowledge = hasKnowledgeIndex
    ? "Start with [the Noxroot knowledge index](.noxroot/knowledge/INDEX.md). Load only the relevant routes, source, tests, and procedures; keep runtime sessions, application memory, user data, and raw transcripts out of project knowledge."
    : "Load only relevant repository source, tests, and existing instructions; keep runtime sessions, application memory, user data, and raw transcripts out of project knowledge.";
  return `${MANAGED_START}
## Noxroot workflow

${knowledge}

${workflow}
${MANAGED_END}`;
}

const VERIFY_SKILL = `---
name: verify-change
description: Verify an actual repository change with approved evidence; use after implementation and before handoff or review.
---

# Verify a change

1. Inspect the actual diff and the task acceptance criteria.
2. Use Noxroot's approved verification plan. Do not invent commands, install tools, or change policy merely to pass.
3. Exercise the real product surface only when a relevant repository adapter already exists and is approved.
4. Record each exact command, status, and bounded evidence. Identify unavailable or unmatched checks as gaps.
5. Never treat one passing check as proof of total correctness.

Return a concise structured result with changed surfaces, checks and statuses, evidence, gaps, residual risks, and the next required action.
`;

const REVIEW_SKILL = `---
name: independent-review
description: Independently review a verified repository diff; use for fresh-context approval, change requests, or a blocked decision.
---

# Independent review

Inspect the diff independently of worker rationale. Check acceptance criteria, correctness, security, regression risk, architecture boundaries, and test adequacy. Cite specific evidence and severity; block when evidence is insufficient. Propose learning candidates only for reusable lessons.

For automated mode, emit exactly one JSON object and no prose:

\`\`\`json
{"decision":"approved|changes-requested|blocked","summary":"factual summary","findings":[{"severity":"critical|high|medium|low","path":"optional/path","evidence":"specific evidence","requiredOutcome":"required result"}],"learningCandidates":[]}
\`\`\`
`;

const PRODUCT_UX_SKILL = `---
name: product-ux-review
description: Review an applicable user-facing product change for intent and usability; use only for UI, interaction, responsive, or product-copy work.
---

# Product and UX review

Identify the user's primary job before visual polish. Check information hierarchy, progressive disclosure, direct minimal language, accessibility, keyboard behavior, responsive intent, and loading, empty, error, partial, disabled, and success states where relevant.

Reuse the repository's accepted product intent, vocabulary, design system, tokens, primitives, spacing, typography, and interaction patterns. Do not expose internal policy, engine state, confidence machinery, or compliance explanations unless users need them.

Use only existing approved browser/mobile tooling and justified viewports or states. Capture supported evidence without uncontrolled screenshot matrices. Distinguish visual difference from product-intent failure. Return concrete findings with evidence, surface, severity, and required outcome. This generic procedure never supplies project-specific product decisions.
`;

function createPatch(file: string, content: string): string {
  const lines = content.replace(/\n$/, "").split("\n");
  return [
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function updatePatch(file: string, before: string, after: string): string {
  const beforeLines = before.replace(/\r?\n$/, "").split(/\r?\n/);
  const afterLines = after.replace(/\r?\n$/, "").split(/\r?\n/);
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function proposed(pathname: string, reason: string, content: string): ProposedFile {
  return {
    path: pathname,
    action: "create",
    reason,
    content,
    patch: createPatch(pathname, content),
  };
}

function reference(pathname: string, reason: string): ProposedFile {
  return { path: pathname, action: "reference", reason };
}

function patchProposal(
  pathname: string,
  reason: string,
  before: string,
  after: string,
): ProposedFile {
  return {
    path: pathname,
    action: "patch",
    reason,
    content: after,
    patch: updatePatch(pathname, before, after),
    expectedHash: createHash("sha256").update(before).digest("hex"),
  };
}

function configContent(modules: ModuleAssessment[]): string {
  const enabled = modules
    .filter((module) => module.status === "recommended" || module.status === "enabled")
    .map((module) => module.id);
  const lifecycleEnabled = enabled.includes("orchestration");
  const config: Record<string, unknown> = {
    version: 1,
    modules: enabled,
    roots: ["."],
    entrypoints: ["AGENTS.md"],
    context: { budgetBytes: 16_000, documentWarningBytes: 24_000 },
    sensitivePaths: [],
    retention: { evidenceDays: 30, maximumRuns: 100 },
  };
  if (lifecycleEnabled) {
    config.autonomy = { default: 0, implementation: 2, review: 3, merge: 0, delivery: 0 };
    config.agents = { default: "manual", adapters: { manual: { type: "manual" } } };
    config.budgets = {
      workerCalls: 2,
      reviewerCalls: 2,
      repairIterations: 1,
      outputBytes: 65_536,
    };
  }
  return stringify(config);
}

function verificationContent(commands: CandidateCommand[]): string {
  return stringify({
    version: 1,
    commands: commands.map((command) => ({
      id: command.id,
      executable: command.executable,
      args: command.args,
      cwd: command.cwd,
      timeoutMs: 120_000,
      appliesTo: command.appliesTo,
    })),
  });
}

const MAX_INDEX_DOCUMENTS = 12;

function documentFamily(pathname: string): { key: string; preference: number } {
  const segments = pathname.split("/");
  const docsIndex = segments.findIndex((segment) => segment.toLowerCase() === "docs");
  const locale = docsIndex >= 0 ? segments[docsIndex + 1] : undefined;
  if (!locale || !/^[a-z]{2}(?:-[a-z]{2,4})?$/i.test(locale)) {
    return { key: pathname.toLowerCase(), preference: 0 };
  }
  const family = [...segments];
  family.splice(docsIndex + 1, 1);
  const normalizedLocale = locale.toLowerCase();
  return {
    key: family.join("/").toLowerCase(),
    preference: normalizedLocale === "en" || normalizedLocale.startsWith("en-") ? 1 : 2,
  };
}

function allUsefulDocuments(
  profile: RepositoryProfile,
  adoption?: AdoptionInspection,
): RepositoryDocument[] {
  const documents = [
    ...profile.documents.filter(
      (document) => document.authoritative && document.kind !== "instructions",
    ),
    ...(adoption?.referencedDocuments ?? []),
  ];
  const priority: Record<RepositoryDocument["kind"], number> = {
    architecture: 0,
    product: 1,
    ux: 2,
    testing: 3,
    security: 4,
    contribution: 5,
    ordinary: 6,
    instructions: 7,
  };
  const uniquePaths = documents
    .filter(
      (document, index, all) =>
        all.findIndex((candidate) => candidate.path === document.path) === index,
    )
    .sort(
      (left, right) =>
        priority[left.kind] - priority[right.kind] || left.path.localeCompare(right.path),
    );
  const families = new Map<string, RepositoryDocument>();
  for (const document of uniquePaths) {
    const candidate = documentFamily(document.path);
    const current = families.get(candidate.key);
    if (!current) {
      families.set(candidate.key, document);
      continue;
    }
    const currentPreference = documentFamily(current.path).preference;
    if (
      candidate.preference < currentPreference ||
      (candidate.preference === currentPreference && document.path.localeCompare(current.path) < 0)
    ) {
      families.set(candidate.key, document);
    }
  }
  return [...families.values()];
}

function usefulDocuments(
  profile: RepositoryProfile,
  adoption?: AdoptionInspection,
): RepositoryDocument[] {
  return allUsefulDocuments(profile, adoption).slice(0, MAX_INDEX_DOCUMENTS);
}

function routesContent(
  profile: RepositoryProfile,
  skillPaths: string[],
  adoption?: AdoptionInspection,
): string {
  const projectRoots = [
    ...new Set(
      profile.files
        .filter(
          (file) =>
            ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"].includes(
              path.posix.basename(file),
            ) &&
            !/(?:^|\/)(?:tests?\/)?fixtures?(?:\/|$)|(?:^|\/)(?:examples?|samples?)(?:\/|$)/.test(
              file,
            ),
        )
        .map((file) => path.posix.dirname(file))
        .filter((directory) => directory !== ".")
        .map((directory) => `${directory}/**`),
    ),
  ];
  const sourceRoots = ["src/**", "app/**", "lib/**", "packages/**", "apps/**"].filter((glob) =>
    profile.files.some((file) => file.startsWith(glob.replace("/**", "/"))),
  );
  const conventional = new Set(sourceRoots.map((glob) => glob.replace("/**", "")));
  const excludedTopLevel = new Set([
    "docs",
    "test",
    "tests",
    "e2e",
    "examples",
    "fixtures",
    "scripts",
    "dist",
    "build",
    "coverage",
  ]);
  const discoveredSourceRoots = [
    ...new Set(
      profile.files
        .filter((file) =>
          /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|cs|rb|php)$/.test(file),
        )
        .map((file) => file.split("/")[0] ?? "")
        .filter(
          (directory) =>
            directory.length > 0 &&
            fileHasDirectory(directory, profile.files) &&
            !directory.startsWith(".") &&
            !conventional.has(directory) &&
            !excludedTopLevel.has(directory),
        )
        .map((directory) => `${directory}/**`),
    ),
  ];
  const testRoots = ["tests/**", "test/**", "e2e/**"].filter((glob) =>
    profile.files.some((file) => file.startsWith(glob.replace("/**", "/"))),
  );
  return stringify({
    version: 1,
    routes: [
      {
        id: "default",
        match: ["**/*"],
        include: [
          ...new Set([
            "AGENTS.md",
            ".noxroot/knowledge/INDEX.md",
            ...usefulDocuments(profile, adoption).map((document) => document.path),
            ...skillPaths,
            ...projectRoots,
            ...sourceRoots,
            ...discoveredSourceRoots,
            ...testRoots,
          ]),
        ],
        exclude: ["dist/**", "coverage/**", "node_modules/**"],
      },
    ],
  });
}

function fileHasDirectory(directory: string, files: string[]): boolean {
  return files.some((file) => file.startsWith(`${directory}/`));
}

function indexLink(document: RepositoryDocument): string {
  const relative = path.posix.relative(".noxroot/knowledge", document.path);
  const basename = path.posix.basename(document.path).replace(/\.(?:md|mdx)$/i, "");
  const label =
    document.kind === "ux"
      ? "Product and UX"
      : document.kind === "architecture" && basename.toLowerCase() !== "architecture"
        ? basename.toLowerCase() === "readme"
          ? "Architecture overview"
          : basename.toLowerCase() === "ai"
            ? "AI architecture"
            : `${basename
                .replaceAll("-", " ")
                .replace(/^./, (value) => value.toUpperCase())} architecture`
        : `${document.kind[0]?.toUpperCase() ?? ""}${document.kind.slice(1)}`;
  return `- [${label}](${relative}) — existing repository documentation; load only when relevant.`;
}

function indexContent(
  profile: RepositoryProfile,
  skillPaths: string[],
  adoption?: AdoptionInspection,
): string {
  const documents = usefulDocuments(profile, adoption);
  const omittedDocuments = Math.max(
    0,
    allUsefulDocuments(profile, adoption).length - documents.length,
  );
  const entries = profile.empty
    ? [
        "- Product intent and architecture are currently unknown. Add evidence before expanding this index.",
      ]
    : [
        ...documents.map(indexLink),
        ...(omittedDocuments > 0
          ? [
              `- Additional repository documentation remains in place (${omittedDocuments} files); discover it through repository instructions or task context when relevant.`,
            ]
          : []),
        "- Verification policy is stored in `../verification.yml` when confirmed.",
        ...(skillPaths.length
          ? [
              `- Task procedures live under \`../skills/\`; load only a relevant \`SKILL.md\`: ${skillPaths.join(
                ", ",
              )}.`,
            ]
          : []),
      ];
  return `# Noxroot knowledge index

Read this index after the repository's nearest agent instructions. Follow links only when relevant to the task; executable source and tests remain authoritative.

${entries.join("\n")}

Active run state, application runtime sessions, application memory, user data, and raw transcripts do not belong in this directory.
`;
}

function integrateAgents(source: string, block: string): ProposedFile {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const managedBlock = block.replaceAll("\n", newline);
  const equivalentLifecycle = ["start", "finish"].every((command) =>
    new RegExp(`\\bnoxroot(?:@[^\\s\`]+)?\\s+${command}\\b`, "i").test(source),
  );
  if (
    source.includes(".noxroot/knowledge/INDEX.md") &&
    equivalentLifecycle &&
    !source.includes(MANAGED_START)
  ) {
    return reference("AGENTS.md", "Reuse the existing equivalent Noxroot knowledge entrypoint.");
  }
  const start = source.indexOf(MANAGED_START);
  const end = source.indexOf(MANAGED_END);
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    return reference(
      "AGENTS.md",
      "A partial or malformed Noxroot managed block requires manual reconciliation; no patch is proposed.",
    );
  }
  if (start !== -1 && end !== -1) {
    const afterEnd = end + MANAGED_END.length;
    const existingBlock = source.slice(start, afterEnd);
    const sameManagedContent =
      existingBlock === managedBlock ||
      existingBlock.replace(/\s+/g, " ").trim() === managedBlock.replace(/\s+/g, " ").trim();
    if (sameManagedContent) {
      return reference("AGENTS.md", "Reuse the existing idempotent Noxroot managed block.");
    }
    const updated = `${source.slice(0, start)}${managedBlock}${source.slice(afterEnd)}`;
    return patchProposal(
      "AGENTS.md",
      "Update only the delimited Noxroot-managed block; preserve surrounding user instructions.",
      source,
      updated,
    );
  }
  const separator =
    source.length === 0 || source.endsWith(`${newline}${newline}`)
      ? ""
      : source.endsWith(newline)
        ? newline
        : `${newline}${newline}`;
  return patchProposal(
    "AGENTS.md",
    "Append a minimal delimited Noxroot entrypoint while preserving all existing instructions.",
    source,
    `${source}${separator}${managedBlock}${newline}`,
  );
}

export function assessModules(
  profile: RepositoryProfile,
  enabledModules?: ReadonlySet<string>,
  adoption?: AdoptionInspection,
): ModuleAssessment[] {
  const initialized = enabledModules !== undefined;
  const status = (
    id: ModuleAssessment["id"],
    initial: ModuleAssessment["status"],
  ): ModuleAssessment["status"] =>
    initialized ? (enabledModules.has(id) ? "enabled" : "disabled") : initial;
  const hasBrowser = profile.evidence.some((item) => item.claim.includes("Playwright"));
  const hasUserFacingProduct = profile.evidence.some(
    (item) => item.claim === "User-facing web application",
  );
  const hasChecks =
    profile.candidateCommands.length > 0 || (adoption?.verificationWrappers.length ?? 0) > 0;
  const orchestrationConflict = adoption?.capabilities.some(
    (item) => item.id === "task-orchestration" && item.decision === "conflict",
  );
  const orchestrationNotAssessed = adoption?.capabilities.some(
    (item) => item.id === "task-orchestration" && item.decision === "not-assessed",
  );
  const projectKnowledgeNotAssessed = adoption?.capabilities.some(
    (item) => item.id === "project-knowledge" && item.decision === "not-assessed",
  );
  return [
    {
      id: "repository-profile",
      label: "Repository profile",
      status: status("repository-profile", "recommended"),
      reason: "Core deterministic repository evidence and limits.",
    },
    {
      id: "agent-routing",
      label: "Agent routing",
      status: projectKnowledgeNotAssessed ? "blocked" : status("agent-routing", "recommended"),
      reason: projectKnowledgeNotAssessed
        ? "Repository knowledge could not be assessed, so no new routing entrypoint is proposed."
        : "Provides a small vendor-neutral entrypoint and bounded context routes.",
    },
    {
      id: "project-knowledge",
      label: "Project knowledge",
      status: projectKnowledgeNotAssessed
        ? "blocked"
        : status("project-knowledge", profile.empty ? "optional" : "recommended"),
      reason: projectKnowledgeNotAssessed
        ? "Project knowledge remains unchanged until the missing repository evidence is available."
        : profile.empty
          ? "No implementation evidence exists; only an index is justified."
          : "Existing authoritative docs are referenced instead of duplicated.",
    },
    {
      id: "verification",
      label: "Verification",
      status: hasChecks ? status("verification", "recommended") : "blocked",
      reason: hasChecks
        ? adoption?.verificationWrappers.length
          ? `${adoption.verificationWrappers.length} documented repository verification wrapper(s) can be reused.`
          : `${profile.candidateCommands.length} candidate command(s) require confirmation.`
        : "No authoritative verification command was detected.",
    },
    {
      id: "product-ux",
      label: "Product and UX",
      status: hasUserFacingProduct ? status("product-ux", "recommended") : "not applicable",
      reason: hasUserFacingProduct
        ? "User-facing source or framework evidence makes the product/UX procedure applicable."
        : "No evidence currently establishes a user-facing product.",
    },
    {
      id: "orchestration",
      label: "Orchestration",
      status:
        orchestrationConflict || orchestrationNotAssessed
          ? "blocked"
          : status("orchestration", profile.empty ? "optional" : "recommended"),
      reason: orchestrationConflict
        ? "An existing repository-development coordinator owns overlapping lifecycle behavior."
        : orchestrationNotAssessed
          ? "Repository-development orchestration could not be assessed, so Noxroot leaves lifecycle behavior unchanged."
          : "Manual mode is available; command execution requires an explicitly configured adapter.",
    },
    {
      id: "learning",
      label: "Learning",
      status:
        orchestrationConflict || orchestrationNotAssessed
          ? "blocked"
          : status("learning", profile.empty ? "optional" : "recommended"),
      reason: orchestrationConflict
        ? "Learning tied to Noxroot completion is disabled while the existing coordinator owns the lifecycle."
        : orchestrationNotAssessed
          ? "Learning tied to Noxroot completion remains disabled until lifecycle ownership can be assessed."
          : "Only completed, evidenced runs may propose durable consolidation.",
    },
    {
      id: "browser-qa",
      label: "Browser QA",
      status: hasBrowser ? status("browser-qa", "recommended") : "not applicable",
      reason: hasBrowser
        ? "Existing Playwright configuration can be reused after commands are confirmed."
        : "No compatible browser-verification tooling was detected.",
    },
  ];
}

export async function buildProposals(
  profile: RepositoryProfile,
  modules: ModuleAssessment[],
  adoption?: AdoptionInspection,
): Promise<ProposedFile[]> {
  if (adoption && !adoption.initializationAllowed) return [];
  const present = new Set(profile.files);
  const decision = (id: CapabilityAssessment["id"]): CapabilityDecision | undefined =>
    adoption?.capabilities.find((item) => item.id === id)?.decision;
  const orchestrationConflict = decision("task-orchestration") === "conflict";
  const orchestrationUnavailable = ["conflict", "not-assessed"].includes(
    decision("task-orchestration") ?? "",
  );
  const effectiveModules = modules.map((module) =>
    orchestrationUnavailable && (module.id === "orchestration" || module.id === "learning")
      ? {
          ...module,
          status: "blocked" as const,
          reason: orchestrationConflict
            ? "The existing repository coordinator owns this lifecycle capability."
            : "Lifecycle ownership was not assessed, so the repository remains unchanged for this capability.",
        }
      : module,
  );
  const active = (id: ModuleAssessment["id"]): boolean =>
    effectiveModules.some(
      (module) =>
        module.id === id && (module.status === "recommended" || module.status === "enabled"),
    );
  const proposals: ProposedFile[] = [];
  const generatedSkillPaths = [
    ...(active("verification") &&
    decision("verification-skill") !== "reuse" &&
    decision("verification-skill") !== "not-assessed"
      ? [".noxroot/skills/verify-change/SKILL.md"]
      : []),
    ...(active("orchestration") &&
    (adoption?.reviewSkillPaths.length ?? 0) === 0 &&
    decision("task-orchestration") !== "reuse" &&
    decision("task-orchestration") !== "not-assessed"
      ? [".noxroot/skills/independent-review/SKILL.md"]
      : []),
    ...(active("product-ux") &&
    (adoption?.productUxSkillPaths.length ?? 0) === 0 &&
    decision("product-ux-guidance") !== "reuse" &&
    decision("product-ux-guidance") !== "not-assessed"
      ? [".noxroot/skills/product-ux-review/SKILL.md"]
      : []),
  ];
  const skillPaths = [
    ...new Set([
      ...generatedSkillPaths,
      ...(adoption?.verificationSkillPaths ?? []),
      ...(adoption?.reviewSkillPaths ?? []),
      ...(adoption?.productUxSkillPaths ?? []),
    ]),
  ];
  const needsIndex =
    (active("agent-routing") || active("project-knowledge")) &&
    decision("project-knowledge") !== "not-assessed" &&
    !present.has(".noxroot/knowledge/INDEX.md");
  const hasKnowledgeIndex = present.has(".noxroot/knowledge/INDEX.md") || needsIndex;
  const instructions = managedBlock(
    orchestrationConflict ? "companion" : active("orchestration") ? "full" : "context-only",
    hasKnowledgeIndex,
  );

  if (active("agent-routing")) {
    if (!present.has("AGENTS.md")) {
      proposals.push(
        proposed(
          "AGENTS.md",
          "Create a concise vendor-neutral entrypoint.",
          `# Repository agent instructions

${instructions}
`,
        ),
      );
    } else {
      const integration = integrateAgents(
        await readFile(path.join(profile.root, "AGENTS.md"), "utf8"),
        instructions,
      );
      if (integration.action === "patch" || needsIndex) proposals.push(integration);
    }
  }
  if (!present.has(".noxroot/config.yml")) {
    proposals.push(
      proposed(
        ".noxroot/config.yml",
        "Add the versioned minimum Noxroot configuration.",
        configContent(effectiveModules),
      ),
    );
  }
  if (needsIndex) {
    proposals.push(
      proposed(
        ".noxroot/knowledge/INDEX.md",
        "Create a progressive-disclosure index that links existing authoritative docs.",
        indexContent(profile, skillPaths, adoption),
      ),
    );
    proposals.push(
      ...usefulDocuments(profile, adoption).map((document) =>
        reference(
          document.path,
          `Reference existing ${document.kind} documentation; do not copy it.`,
        ),
      ),
    );
  }
  if (
    active("agent-routing") &&
    decision("task-routes") !== "reuse" &&
    decision("task-routes") !== "not-assessed" &&
    !profile.empty &&
    !present.has(".noxroot/routes.yml")
  ) {
    proposals.push(
      proposed(
        ".noxroot/routes.yml",
        "Add evidence-backed candidate routes for source, tests, and existing docs.",
        routesContent(profile, skillPaths, adoption),
      ),
    );
  }
  if (
    active("verification") &&
    decision("verification-policy") !== "reuse" &&
    decision("verification-policy") !== "not-assessed" &&
    profile.candidateCommands.length > 0 &&
    !present.has(".noxroot/verification.yml")
  ) {
    proposals.push(
      proposed(
        ".noxroot/verification.yml",
        "Confirm the exact discovered commands as executable verification policy.",
        verificationContent(profile.candidateCommands),
      ),
    );
  }
  const skills = new Map([
    [".noxroot/skills/verify-change/SKILL.md", VERIFY_SKILL],
    [".noxroot/skills/independent-review/SKILL.md", REVIEW_SKILL],
    [".noxroot/skills/product-ux-review/SKILL.md", PRODUCT_UX_SKILL],
  ]);
  for (const skillPath of generatedSkillPaths) {
    if (!present.has(skillPath)) {
      proposals.push(
        proposed(
          skillPath,
          "Add a short standards-compatible procedure at the canonical Noxroot skill path.",
          skills.get(skillPath)!,
        ),
      );
    }
  }
  return proposals;
}
