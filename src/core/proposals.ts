import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import type {
  CandidateCommand,
  ModuleAssessment,
  ProposedFile,
  RepositoryDocument,
  RepositoryProfile,
} from "../model.js";

const MANAGED_START = "<!-- noxroot:start -->";
const MANAGED_END = "<!-- noxroot:end -->";
const MANAGED_BLOCK = `${MANAGED_START}
## Noxroot workflow

Start with [the Noxroot knowledge index](.noxroot/knowledge/INDEX.md). Load only the relevant routes, source, tests, and procedures; keep runtime sessions, application memory, user data, and raw transcripts out of project knowledge.

When \`.noxroot/skills/\` exists, load only the task-relevant \`SKILL.md\`: verification for changed-code checks, independent review for fresh review, and product/UX review only for applicable user-facing work.
${MANAGED_END}`;

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
  const beforeLines = before.replace(/\n$/, "").split("\n");
  const afterLines = after.replace(/\n$/, "").split("\n");
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
  return stringify({
    version: 1,
    modules: enabled,
    roots: ["."],
    entrypoints: ["AGENTS.md"],
    context: { budgetBytes: 16_000, documentWarningBytes: 24_000 },
    autonomy: { default: 0, implementation: 2, review: 3, merge: 0, delivery: 0 },
    agents: { default: "manual", adapters: { manual: { type: "manual" } } },
    budgets: { workerCalls: 2, reviewerCalls: 2, repairIterations: 1, outputBytes: 65_536 },
    sensitivePaths: [],
    retention: { evidenceDays: 30, maximumRuns: 100 },
  });
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

function usefulDocuments(profile: RepositoryProfile): RepositoryDocument[] {
  return profile.documents.filter(
    (document) => document.authoritative && document.kind !== "instructions",
  );
}

function routesContent(profile: RepositoryProfile, skillPaths: string[]): string {
  const sourceRoots = ["src/**", "app/**", "lib/**", "packages/**", "apps/**"].filter((glob) =>
    profile.files.some((file) => file.startsWith(glob.replace("/**", "/"))),
  );
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
          "AGENTS.md",
          ".noxroot/knowledge/INDEX.md",
          ...usefulDocuments(profile).map((document) => document.path),
          ...skillPaths,
          ...sourceRoots,
          ...testRoots,
        ],
        exclude: ["dist/**", "coverage/**", "node_modules/**"],
      },
    ],
  });
}

function indexLink(document: RepositoryDocument): string {
  const relative = path.posix.relative(".noxroot/knowledge", document.path);
  const label =
    document.kind === "ux"
      ? "Product and UX"
      : `${document.kind[0]?.toUpperCase() ?? ""}${document.kind.slice(1)}`;
  return `- [${label}](${relative}) — existing repository documentation; load only when relevant.`;
}

function indexContent(profile: RepositoryProfile, skillPaths: string[]): string {
  const documents = usefulDocuments(profile);
  const entries = profile.empty
    ? [
        "- Product intent and architecture are currently unknown. Add evidence before expanding this index.",
      ]
    : [
        ...documents.map(indexLink),
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

function integrateAgents(source: string): ProposedFile {
  if (source.includes(".noxroot/knowledge/INDEX.md") && !source.includes(MANAGED_START)) {
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
    if (existingBlock === MANAGED_BLOCK) {
      return reference("AGENTS.md", "Reuse the existing idempotent Noxroot managed block.");
    }
    const updated = `${source.slice(0, start)}${MANAGED_BLOCK}${source.slice(afterEnd)}`;
    return patchProposal(
      "AGENTS.md",
      "Update only the delimited Noxroot-managed block; preserve surrounding user instructions.",
      source,
      updated,
    );
  }
  const separator =
    source.length === 0 || source.endsWith("\n\n") ? "" : source.endsWith("\n") ? "\n" : "\n\n";
  return patchProposal(
    "AGENTS.md",
    "Append a minimal delimited Noxroot entrypoint while preserving all existing instructions.",
    source,
    `${source}${separator}${MANAGED_BLOCK}\n`,
  );
}

export function assessModules(
  profile: RepositoryProfile,
  enabledModules?: ReadonlySet<string>,
): ModuleAssessment[] {
  const initialized = enabledModules !== undefined;
  const status = (
    id: ModuleAssessment["id"],
    initial: ModuleAssessment["status"],
  ): ModuleAssessment["status"] =>
    initialized ? (enabledModules.has(id) ? "enabled" : "disabled") : initial;
  const hasBrowser = profile.evidence.some((item) => item.claim.includes("Playwright"));
  const hasChecks = profile.candidateCommands.length > 0;
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
      status: status("agent-routing", "recommended"),
      reason: "Provides a small vendor-neutral entrypoint and bounded context routes.",
    },
    {
      id: "project-knowledge",
      label: "Project knowledge",
      status: status("project-knowledge", profile.empty ? "optional" : "recommended"),
      reason: profile.empty
        ? "No implementation evidence exists; only an index is justified."
        : "Existing authoritative docs are referenced instead of duplicated.",
    },
    {
      id: "verification",
      label: "Verification",
      status: hasChecks ? status("verification", "recommended") : "blocked",
      reason: hasChecks
        ? `${profile.candidateCommands.length} candidate command(s) require confirmation.`
        : "No authoritative verification command was detected.",
    },
    {
      id: "product-ux",
      label: "Product and UX",
      status: hasBrowser ? status("product-ux", "optional") : "not applicable",
      reason: hasBrowser
        ? "Browser tooling exists, but product intent must be declared before UX rules are created."
        : "No evidence currently establishes a user-facing browser product.",
    },
    {
      id: "orchestration",
      label: "Orchestration",
      status: status("orchestration", profile.empty ? "optional" : "recommended"),
      reason:
        "Manual mode is available; command execution requires an explicitly configured adapter.",
    },
    {
      id: "learning",
      label: "Learning",
      status: status("learning", profile.empty ? "optional" : "recommended"),
      reason: "Only completed, evidenced runs may propose durable consolidation.",
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
): Promise<ProposedFile[]> {
  const present = new Set(profile.files);
  const active = (id: ModuleAssessment["id"]): boolean =>
    modules.some(
      (module) =>
        module.id === id && (module.status === "recommended" || module.status === "enabled"),
    );
  const proposals: ProposedFile[] = [];
  const skillPaths = [
    ...(active("verification") ? [".noxroot/skills/verify-change/SKILL.md"] : []),
    ...(active("orchestration") ? [".noxroot/skills/independent-review/SKILL.md"] : []),
    ...(active("product-ux") ? [".noxroot/skills/product-ux-review/SKILL.md"] : []),
  ];
  const needsIndex =
    (active("agent-routing") || active("project-knowledge")) &&
    !present.has(".noxroot/knowledge/INDEX.md");

  if (active("agent-routing")) {
    if (!present.has("AGENTS.md")) {
      proposals.push(
        proposed(
          "AGENTS.md",
          "Create a concise vendor-neutral entrypoint.",
          `# Repository agent instructions

${MANAGED_BLOCK}
`,
        ),
      );
    } else if (needsIndex) {
      proposals.push(integrateAgents(await readFile(path.join(profile.root, "AGENTS.md"), "utf8")));
    }
  }
  if (!present.has(".noxroot/config.yml")) {
    proposals.push(
      proposed(
        ".noxroot/config.yml",
        "Add the versioned minimum Noxroot configuration.",
        configContent(modules),
      ),
    );
  }
  if (needsIndex) {
    proposals.push(
      proposed(
        ".noxroot/knowledge/INDEX.md",
        "Create a progressive-disclosure index that links existing authoritative docs.",
        indexContent(profile, skillPaths),
      ),
    );
    proposals.push(
      ...usefulDocuments(profile).map((document) =>
        reference(
          document.path,
          `Reference existing ${document.kind} documentation; do not copy it.`,
        ),
      ),
    );
  }
  if (active("agent-routing") && !profile.empty && !present.has(".noxroot/routes.yml")) {
    proposals.push(
      proposed(
        ".noxroot/routes.yml",
        "Add evidence-backed candidate routes for source, tests, and existing docs.",
        routesContent(profile, skillPaths),
      ),
    );
  }
  if (
    active("verification") &&
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
  for (const skillPath of skillPaths) {
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
