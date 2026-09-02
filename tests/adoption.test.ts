import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyProposals } from "../src/core/init.js";
import { previewRepository } from "../src/core/preview.js";
import { hashTree, temporaryDirectory } from "./helpers.js";

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
  });

  it("refuses initialization when an existing tool owns repository-development orchestration", async () => {
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

    expect(preview.initializationAllowed).toBe(false);
    const orchestration = preview.capabilities.find((item) => item.id === "task-orchestration");
    expect(orchestration).toMatchObject({ decision: "conflict" });
    expect(orchestration?.evidence.some((item) => item.includes("repo-flow"))).toBe(true);
    expect(preview.proposedFiles).toEqual([]);
    await expect(applyProposals(preview)).rejects.toThrow("initialization is refused");
    expect(await hashTree(repository)).toBe(before);
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
