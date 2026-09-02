import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/core/context.js";
import { previewRepository } from "../src/core/preview.js";
import { renderPreview } from "../src/output.js";
import { fixtures } from "./helpers.js";

describe("documentation examples", () => {
  it("keeps the README opening and preview excerpt synchronized with a real fixture", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    expect(readme.startsWith('<p align="center">\n  <img src="docs/assets/noxroot-logo.svg"')).toBe(
      true,
    );
    expect(readme).toContain(
      "Project memory and orchestration for the coding agent you already use.",
    );
    const output = renderPreview(await previewRepository(path.join(fixtures, "typescript")));
    for (const line of [
      "NOXROOT PREVIEW",
      "Detected: Node.js project, TypeScript (npm)",
      "Approved check candidates found: lint, typecheck, test, build",
      "Proposed (7): create 7",
      "Unknown: Continuous integration",
      "Trust: files changed 0; repository commands 0; agent calls 0; network requests 0.",
      "No repository files changed. No project command, agent, or network request ran.",
      "Next: noxroot preview --diff",
    ]) {
      expect(output).toContain(line);
      expect(readme).toContain(line);
    }
  });

  it("keeps the README context proof synchronized with the dogfood route", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    const context = await buildContext("improve reviewer decision safety", path.resolve("."));
    const checks = context.requiredVerification.map((item) => item.id).join(", ");
    const relatedTests =
      context.likelyTests.length > 1 ? ` (+${context.likelyTests.length - 1} related)` : "";
    for (const line of [
      `Selected ${context.selected.length} of ${context.repositoryFileCount} repository files · ~${context.budget.estimatedTokens.toLocaleString("en-US")} tokens`,
      `Likely owner: ${context.likelyOwningSource[0]}`,
      `Likely tests: ${context.likelyTests[0]}${relatedTests}`,
      `Approved checks: ${checks}`,
      `Deliberately excluded: ${context.repositoryFileCount - context.selected.length} unrelated files`,
    ]) {
      expect(readme).toContain(line);
    }
  });

  it("documents the application-agent framework boundary", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    expect(readme).toContain("Application-agent frameworks are detected project architectures");
    expect(readme).toMatch(/runtime sessions,\s+state, memory, and\s+user data/);
  });

  it("keeps the README focused and every relative link or image resolvable", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    let inFence = false;
    const prose = readme
      .split("\n")
      .filter((line) => {
        if (line.startsWith("```")) {
          inFence = !inFence;
          return false;
        }
        return !inFence && !line.trim().startsWith("|");
      })
      .join(" ")
      .replace(/!?\[[^\]]*\]\([^)]+\)/g, " ");
    const words = prose.match(/[A-Za-z0-9][A-Za-z0-9'./+—-]*/g) ?? [];
    expect(words.length).toBeGreaterThanOrEqual(800);
    expect(words.length).toBeLessThanOrEqual(1_100);

    for (const match of readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1]!;
      if (/^(?:https?:|mailto:|#)/.test(target)) continue;
      await expect(access(path.resolve(target.split("#")[0]!))).resolves.toBeUndefined();
    }
    const assets = ["noxroot-logo.svg", "noxroot-workflow.svg"];
    expect((await readdir(path.resolve("docs", "assets"))).sort()).toEqual(assets);
    expect(readme).toContain("This transcript illustrates the stable information hierarchy");
    for (const asset of assets) {
      const svg = await readFile(path.resolve("docs", "assets", asset), "utf8");
      expect(svg).toContain("<svg");
      expect(svg).toContain('role="img"');
      expect(svg).toContain("aria-labelledby=");
      expect(svg).toContain("<title");
      expect(svg).toContain("<desc");
    }
    const workflow = await readFile(path.resolve("docs/assets/noxroot-workflow.svg"), "utf8");
    expect(workflow).toContain('viewBox="0 0 1100 1040"');
    expect(workflow).toContain("PROJECT MEMORY");
    expect(workflow).toContain("TASK CONTEXT");
    expect(workflow).toContain("YOUR CODING AGENT");
    expect(workflow).toContain("VERIFICATION");
    expect(workflow).toContain("LEARNING LOOP");
    const logo = await readFile(path.resolve("docs/assets/noxroot-logo.svg"), "utf8");
    expect(logo).toContain('viewBox="0 0 1600 440"');
    expect(logo).toContain("Noxroot owl mark");
    expect(readme).toContain('src="docs/assets/noxroot-workflow.svg"');
    expect(readme).toContain('width="900"');
    expect(readme).toContain(".noxroot/skills/verify-change/SKILL.md");
    expect(readme).toContain(".git/noxroot/runs/*.json");
    expect(readme).not.toContain("—");
    expect(readme).not.toMatch(
      /auto-documenting|self-training|autonomous team|Obsidian integration|vault system|self-improving AI/i,
    );
  });
});
