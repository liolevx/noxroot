import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildContext } from "../src/core/context.js";
import { doctorRepository } from "../src/core/doctor.js";
import { applyProposals } from "../src/core/init.js";
import { previewRepository } from "../src/core/preview.js";
import { inspectRepositoryAdoption } from "../src/detection/adoption.js";
import { scanRepository } from "../src/detection/scan.js";
import { assessModules, buildProposals } from "../src/core/proposals.js";
import { planVerification } from "../src/verification/index.js";
import { fixtureCopy, hashTree, temporaryDirectory } from "./helpers.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((operation) => operation())));

async function root(): Promise<string> {
  const directory = await temporaryDirectory("noxroot-adoption-");
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

describe("mature repository adoption", () => {
  it("follows explicit references, recognizes forwarding instructions, and reuses procedures", async () => {
    const repository = await root();
    await mkdir(path.join(repository, "docs"), { recursive: true });
    await mkdir(path.join(repository, ".agents", "skills", "project-check"), {
      recursive: true,
    });
    await mkdir(path.join(repository, "tools"), { recursive: true });
    await writeFile(
      path.join(repository, "AGENTS.md"),
      [
        "# Repository instructions",
        "",
        "Start with [project memory](docs/memory.md) and the `docs/task-map.yml` routes.",
        "Use [quality rules](docs/quality.md) and `.agents/skills/project-check/SKILL.md`.",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(repository, "CLAUDE.md"), "@AGENTS.md\n");
    await writeFile(path.join(repository, "docs", "memory.md"), "# Durable decisions\n");
    await writeFile(path.join(repository, "docs", "task-map.yml"), "areas: [frontend, core]\n");
    await writeFile(
      path.join(repository, "docs", "quality.md"),
      "# Quality\n\nThe canonical repository check is `project-check --changed`.\n",
    );
    await writeFile(
      path.join(repository, ".agents", "skills", "project-check", "SKILL.md"),
      "---\nname: project-check\ndescription: Verify changed repository code with the canonical checks.\n---\n\n# Check\n",
    );
    await writeFile(
      path.join(repository, "pyproject.toml"),
      '[project]\nname = "sample"\n\n[project.scripts]\nproject-check = "tools.checks:main"\n',
    );
    await writeFile(path.join(repository, "tools", "checks.py"), "def main():\n    return 0\n");

    const before = await hashTree(repository);
    const preview = await previewRepository(repository);

    expect(await hashTree(repository)).toBe(before);
    expect(preview.initializationAllowed).toBe(true);
    expect(preview.conflicts).not.toContainEqual(
      expect.stringContaining("Multiple root agent instruction sources"),
    );
    expect(preview.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "project-knowledge", decision: "reuse" }),
        expect.objectContaining({ id: "task-routes", decision: "reuse" }),
        expect.objectContaining({ id: "verification-policy", decision: "reuse" }),
        expect.objectContaining({ id: "verification-skill", decision: "reuse" }),
      ]),
    );
    expect(
      preview.capabilities.find((item) => item.id === "verification-policy")?.evidence,
    ).toContain("project-check --changed (docs/quality.md)");
    expect(
      preview.capabilities.find((item) => item.id === "project-knowledge")?.evidence,
    ).not.toContain("CLAUDE.md");
    expect(preview.proposedFiles.map((item) => item.path)).not.toContain(
      ".noxroot/verification.yml",
    );
    expect(preview.proposedFiles.map((item) => item.path)).not.toContain(
      ".noxroot/skills/verify-change/SKILL.md",
    );
    await applyProposals(preview);
    expect(await planVerification(repository)).toEqual([
      expect.objectContaining({
        executable: "project-check",
        args: ["--changed"],
        cwd: ".",
      }),
    ]);
    const context = await buildContext("change repository quality checks", repository);
    expect(context.requiredVerification).toEqual([
      expect.objectContaining({ executable: "project-check", args: ["--changed"] }),
    ]);
    expect((await doctorRepository(repository)).findings).not.toContainEqual(
      expect.objectContaining({ code: "verification-module-drift" }),
    );
  });

  it("adds a reversible entrypoint beside compatible framework-managed instructions", async () => {
    const repository = await root();
    await mkdir(path.join(repository, "app"), { recursive: true });
    const frameworkInstructions = [
      "<!-- BEGIN:framework-agent-rules -->",
      "# Framework instructions",
      "APIs, conventions, and file structure may differ from training data. Read the relevant guide in `node_modules/framework/docs/` before writing code.",
      "This block is maintained by the framework.",
      "<!-- END:framework-agent-rules -->",
      "",
    ].join("\n");
    await writeFile(path.join(repository, "AGENTS.md"), frameworkInstructions);
    await writeFile(path.join(repository, "CLAUDE.md"), "@AGENTS.md\n");
    await writeFile(path.join(repository, "app", "page.tsx"), "export default function Page() {}\n");
    await writeFile(
      path.join(repository, "package.json"),
      JSON.stringify({ scripts: { build: "framework build", lint: "eslint ." } }),
    );

    const preview = await previewRepository(repository);

    expect(preview.initializationAllowed).toBe(true);
    expect(preview.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "project-knowledge", decision: "create" }),
        expect.objectContaining({ id: "task-orchestration", decision: "create" }),
      ]),
    );
    const agents = preview.proposedFiles.find((item) => item.path === "AGENTS.md");
    expect(agents).toMatchObject({ action: "patch" });
    expect(agents?.content).toContain(frameworkInstructions.trim());
    expect(agents?.content).toContain("<!-- noxroot:start -->");
    expect(preview.proposedFiles.map((item) => item.path)).not.toContain("CLAUDE.md");
  });

  it("keeps an existing repository coordinator authoritative while adding only companion capabilities", async () => {
    const repository = await root();
    await mkdir(path.join(repository, "tools"), { recursive: true });
    await writeFile(
      path.join(repository, "AGENTS.md"),
      "# Repository instructions\n\nUse `repo-flow` for repository implementation work.\n",
    );
    await writeFile(
      path.join(repository, "pyproject.toml"),
      '[project]\nname = "sample"\n\n[project.scripts]\nrepo-flow = "tools.repo_flow:main"\n',
    );
    await writeFile(
      path.join(repository, "tools", "repo_flow.py"),
      [
        '"""Coordinate repository code changes."""',
        "def main():",
        '    worktree = "git worktree"',
        '    worker = "implementation worker"',
        '    verification = "run verification"',
        '    reviewer = "independent reviewer"',
        '    merge = "merge exact commit"',
        "    return worktree, worker, verification, reviewer, merge",
        "",
      ].join("\n"),
    );

    const before = await hashTree(repository);
    const preview = await previewRepository(repository);

    expect(preview.initializationAllowed).toBe(true);
    const orchestration = preview.capabilities.find((item) => item.id === "task-orchestration");
    expect(orchestration).toMatchObject({ decision: "conflict" });
    expect(orchestration?.evidence.some((item) => item.includes("repo-flow"))).toBe(true);
    expect(preview.proposedFiles.map((item) => item.path)).not.toContain(
      ".noxroot/skills/independent-review/SKILL.md",
    );

    await applyProposals(preview);
    const config = parse(
      await readFile(path.join(repository, ".noxroot", "config.yml"), "utf8"),
    ) as { modules: string[] };
    expect(config.modules).not.toContain("orchestration");
    expect(config.modules).not.toContain("learning");
    const instructions = await readFile(path.join(repository, "AGENTS.md"), "utf8");
    expect(instructions).toContain("existing repository coordinator remains authoritative");
    expect(instructions).toContain('npx --yes noxroot@0.1.0 context "<task>"');
    expect(instructions).not.toContain("noxroot@0.1.0 start");
    expect(await hashTree(repository)).not.toBe(before);
  });

  it("keeps an adjacent coordination ledger compatible without reusing task orchestration", async () => {
    const fixture = await fixtureCopy("adjacent-ledger");
    cleanup.push(fixture.cleanup);

    const before = await hashTree(fixture.root);
    const preview = await previewRepository(fixture.root);

    expect(await hashTree(fixture.root)).toBe(before);
    expect(preview.initializationAllowed).toBe(true);
    expect(preview.capabilities.find((item) => item.id === "task-orchestration")).toEqual(
      expect.objectContaining({ decision: "create", evidence: [] }),
    );
    expect(preview.capabilities.find((item) => item.id === "coordination-ledger")).toEqual(
      expect.objectContaining({
        decision: "adjacent",
        evidence: [
          "docs/coordination.md (durable work state, cross-session continuity, coding-work coordination)",
        ],
      }),
    );
    expect(preview.conflicts).not.toContainEqual(
      expect.stringContaining("repository-development coordinator"),
    );
  });

  it("does not mistake an internal review ledger for an adjacent coordination capability", async () => {
    const fixture = await fixtureCopy("review-procedure-ledger");
    cleanup.push(fixture.cleanup);

    const preview = await previewRepository(fixture.root);

    expect(preview.capabilities.find((item) => item.id === "coordination-ledger")).toBeUndefined();
  });

  it("detects coordinator behavior without relying on a filename or implementation language", async () => {
    const fixture = await fixtureCopy("behavioral-coordinator");
    cleanup.push(fixture.cleanup);

    const preview = await previewRepository(fixture.root);
    const orchestration = preview.capabilities.find((item) => item.id === "task-orchestration");

    expect(preview.initializationAllowed).toBe(true);
    expect(orchestration).toMatchObject({ decision: "conflict" });
    expect(orchestration?.evidence).toContain(
      "docs/automation.md (AGENTS.md; Git/worktree control, code-change execution, verification, independent review)",
    );
    expect(preview.proposedFiles.map((item) => item.path)).not.toContain(
      ".noxroot/skills/independent-review/SKILL.md",
    );
  });

  it("does not treat coordinator fixtures as live repository authority", async () => {
    const repository = await root();
    await mkdir(path.join(repository, "src"), { recursive: true });
    await mkdir(path.join(repository, "tests", "fixtures", "coordinator", "docs"), {
      recursive: true,
    });
    await writeFile(path.join(repository, "src", "index.ts"), "export {};\n");
    await writeFile(
      path.join(repository, "tests", "fixtures", "coordinator", "AGENTS.md"),
      "Use [automation](docs/automation.md).\n",
    );
    await writeFile(
      path.join(repository, "tests", "fixtures", "coordinator", "docs", "automation.md"),
      "Manage Git worktrees. Run coding workers. Execute verification. Require independent review.\n",
    );

    const preview = await previewRepository(repository);
    expect(preview.capabilities.find((item) => item.id === "task-orchestration")).toMatchObject({
      decision: "create",
    });
    expect(preview.conflicts).not.toContainEqual(
      expect.stringContaining("repository-development coordinator"),
    );
  });

  it("preserves an uncertain capability instead of generating a parallel system", async () => {
    const repository = await root();
    await writeFile(
      path.join(repository, "AGENTS.md"),
      "# Repository instructions\n\nUse [the project routes](docs/missing-routes.yml).\n",
    );
    await writeFile(path.join(repository, "package.json"), '{"name":"sample"}\n');

    const preview = await previewRepository(repository);
    const routes = preview.capabilities.find((item) => item.id === "task-routes");
    expect(routes).toMatchObject({ decision: "not-assessed" });
    expect(routes?.missingEvidence.some((item) => item.includes("docs/missing-routes.yml"))).toBe(
      true,
    );
    expect(preview.proposedFiles.map((item) => item.path)).not.toContain(".noxroot/routes.yml");
  });

  it("does not enable lifecycle modules when orchestration could not be assessed", async () => {
    const repository = await root();
    await writeFile(path.join(repository, "AGENTS.md"), "# Repository instructions\n");
    await writeFile(path.join(repository, "README.md"), "# Sample\n");
    await mkdir(path.join(repository, "src"));
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        writeFile(path.join(repository, "src", `${index}.ts`), "export {};\n"),
      ),
    );

    const profile = await scanRepository(repository, { limits: { maxFiles: 3 } });
    const adoption = await inspectRepositoryAdoption(profile);
    const modules = assessModules(profile, undefined, adoption);
    const proposals = await buildProposals(profile, modules, adoption);
    const config = parse(
      proposals.find((item) => item.path === ".noxroot/config.yml")?.content ?? "",
    ) as { modules: string[] };
    const instructions = proposals.find((item) => item.path === "AGENTS.md")?.content ?? "";

    expect(adoption.capabilities.find((item) => item.id === "task-orchestration")).toMatchObject({
      decision: "not-assessed",
    });
    expect(modules.find((item) => item.id === "orchestration")?.status).toBe("blocked");
    expect(modules.find((item) => item.id === "learning")?.status).toBe("blocked");
    expect(config.modules).not.toContain("orchestration");
    expect(config.modules).not.toContain("learning");
    expect(instructions).not.toContain(' start "');
    expect(instructions).not.toContain(" finish");
  });

  it("does not confuse an application runtime entrypoint with repository orchestration", async () => {
    const repository = await root();
    await mkdir(path.join(repository, "service"), { recursive: true });
    await writeFile(
      path.join(repository, "pyproject.toml"),
      '[project]\nname = "sample"\n\n[project.scripts]\nserve = "service.runtime:main"\n',
    );
    await writeFile(
      path.join(repository, "service", "runtime.py"),
      'def main():\n    return "coordinate application agents and user sessions"\n',
    );

    const preview = await previewRepository(repository);
    expect(preview.initializationAllowed).toBe(true);
    expect(preview.capabilities.find((item) => item.id === "task-orchestration")).toMatchObject({
      decision: "create",
    });
  });

  it("does not confuse application-agent sessions and handoffs with a coding-work ledger", async () => {
    const repository = await root();
    await writeFile(
      path.join(repository, "README.md"),
      "# Agent SDK\n\nBuild agent workflows with sessions, handoffs, tools, and durable application state.\n",
    );
    await writeFile(path.join(repository, "package.json"), '{"name":"agent-sdk"}\n');

    const preview = await previewRepository(repository);

    expect(preview.capabilities.find((item) => item.id === "coordination-ledger")).toBeUndefined();
    expect(preview.capabilities.find((item) => item.id === "task-orchestration")).toMatchObject({
      decision: "create",
    });
  });

  it("reuses clear repository-native review skills instead of creating Noxroot copies", async () => {
    const repository = await root();
    await mkdir(path.join(repository, ".agents", "skills", "change-review"), {
      recursive: true,
    });
    await mkdir(path.join(repository, ".agents", "skills", "product-review"), {
      recursive: true,
    });
    await writeFile(
      path.join(repository, ".agents", "skills", "change-review", "SKILL.md"),
      "---\nname: change-review\ndescription: Independently review a repository diff for correctness and regression risk.\n---\n",
    );
    await writeFile(
      path.join(repository, ".agents", "skills", "product-review", "SKILL.md"),
      "---\nname: product-review\ndescription: Review user-facing product and UX changes for usability.\n---\n",
    );
    await writeFile(
      path.join(repository, "package.json"),
      JSON.stringify({
        name: "frontend",
        packageManager: "npm@11.6.2",
        scripts: { test: "vitest run" },
        dependencies: { next: "16.0.0", react: "19.0.0" },
      }),
    );

    const preview = await previewRepository(repository);
    const adoption = await inspectRepositoryAdoption(preview.profile);
    const proposed = preview.proposedFiles.map((item) => item.path);
    expect(adoption.reviewSkillPaths).toEqual([".agents/skills/change-review/SKILL.md"]);
    expect(adoption.productUxSkillPaths).toEqual([".agents/skills/product-review/SKILL.md"]);
    expect(proposed).not.toContain(".noxroot/skills/independent-review/SKILL.md");
    expect(proposed).not.toContain(".noxroot/skills/product-ux-review/SKILL.md");
    expect(
      preview.proposedFiles.find((item) => item.path === ".noxroot/routes.yml")?.content,
    ).toContain(".agents/skills/change-review/SKILL.md");
    expect(
      preview.proposedFiles.find((item) => item.path === ".noxroot/routes.yml")?.content,
    ).toContain(".agents/skills/product-review/SKILL.md");
  });

  it("does not treat extra prohibitions as a thin forwarding file", async () => {
    const repository = await root();
    await writeFile(
      path.join(repository, "AGENTS.md"),
      "# Instructions\n\nRun the project checks.\n",
    );
    await writeFile(
      path.join(repository, "CLAUDE.md"),
      "Read AGENTS.md, but never run repository commands.\n",
    );

    const preview = await previewRepository(repository);
    expect(preview.initializationAllowed).toBe(false);
    expect(preview.conflicts).toContainEqual(
      expect.stringContaining("Multiple root agent instruction sources"),
    );
  });

  it("adds a real unconventional source root to generated routes", async () => {
    const repository = await root();
    await mkdir(path.join(repository, "engine"), { recursive: true });
    await writeFile(path.join(repository, "pyproject.toml"), '[project]\nname = "sample"\n');
    await writeFile(path.join(repository, "engine", "calculation.py"), "result = 1\n");

    const preview = await previewRepository(repository);
    const routes = preview.proposedFiles.find((item) => item.path === ".noxroot/routes.yml");
    expect(routes?.content).toContain("engine/**");
  });
});
