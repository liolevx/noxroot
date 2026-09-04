import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { previewRepository } from "../src/core/preview.js";
import { renderPreview } from "../src/output.js";
import { fixtures } from "./helpers.js";
import { parse } from "yaml";
import { noxrootConfigSchema, verificationConfigSchema } from "../src/config/schema.js";
import { VERSION } from "../src/invocation.js";

describe("documentation examples", () => {
  it("keeps the README opening and preview excerpt synchronized with a real fixture", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    expect(readme.startsWith('<p align="center">\n  <img src="docs/assets/noxroot-logo.svg"')).toBe(
      true,
    );
    expect(readme).toContain(
      "Give coding agents the project context they need, then check what they changed.",
    );
    expect(readme).toContain(
      "A CLI for project memory, focused task briefs, approved checks, and reusable documentation.",
    );
    expect(readme).toContain("Then keep talking to your coding agent normally.");
    expect(readme).toContain("actions/workflows/ci.yml/badge.svg?branch=main");
    expect(readme).toContain("license-Apache--2.0-blue.svg");
    const output = renderPreview(await previewRepository(path.join(fixtures, "typescript")));
    for (const line of [
      "NOXROOT  preview",
      "Node.js · TypeScript · npm",
      "Mode\n  Full",
      "Project knowledge",
      "Product and UX guidance",
      "No files changed. No project commands or agents ran. No network requests were made.",
      `npx --yes noxroot@${VERSION} preview --diff`,
    ]) {
      expect(output).toContain(line);
      expect(readme).toContain(line);
    }
  });

  it("offers generic npm onboarding without a copyable project-specific task", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    const setup = readme.split("## Set up once")[1]!.split("### What setup can add")[0]!;
    expect(readme).toContain('href="https://www.npmjs.com/package/noxroot"');
    expect(readme).toContain("https://img.shields.io/npm/v/noxroot");
    expect(setup).toContain("Node.js `>=22.12 <27`");
    expect(setup).toContain("npx noxroot@latest preview");
    expect(setup).toContain("npx noxroot@latest init");
    expect(setup).toContain("Commit the reviewed setup");
    expect(setup).not.toMatch(/filters|restaurants|```text/);
    expect(setup).toContain("compatible agents are instructed");
    expect(readme).not.toMatch(/not published to npm yet|intended beta entry point/);
  });

  it("keeps reference configuration valid and delegated agents opt-in", async () => {
    const documentation = await readFile(path.resolve("docs/configuration.md"), "utf8");
    const examples = [...documentation.matchAll(/```yaml\n([\s\S]*?)\n```/g)];
    const config = noxrootConfigSchema.parse(parse(examples[0]![1]!));
    expect(config.agents.default).toBe("manual");
    expect(config.agents.adapters.manual).toEqual({ type: "manual" });
    expect(verificationConfigSchema.parse(parse(examples[1]![1]!)).commands[0]?.cwd).toBe(".");
    expect(documentation).toContain("not working flags for a particular");
  });

  it("keeps the linked guides navigable and explains npm and adapter boundaries", async () => {
    for (const name of [
      "getting-started",
      "commands",
      "configuration",
      "architecture",
      "adapters",
      "security",
      "development",
    ]) {
      const documentation = await readFile(path.resolve(`docs/${name}.md`), "utf8");
      for (const match of documentation.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
        if (/^(?:https?:|mailto:|#)/.test(match[1]!)) continue;
        await expect(
          access(path.resolve("docs", match[1]!.split("#")[0]!)),
        ).resolves.toBeUndefined();
      }
    }
    const commands = await readFile(path.resolve("docs/commands.md"), "utf8");
    expect(commands).toContain(`npx --yes noxroot@${VERSION}`);
    expect(commands).toContain("`Relevant files`, `Related tests`, and `Checks to run`");
    const security = await readFile(path.resolve("docs/security.md"), "utf8");
    expect(security).toContain("the full `npx` invocation is not guaranteed offline");
    const adapters = await readFile(path.resolve("docs/adapters.md"), "utf8");
    expect(adapters).toContain("You do not need to configure an adapter");
    expect(adapters).toContain("automated reviewers");
    const guide = await readFile(path.resolve("docs/getting-started.md"), "utf8");
    const setupStep = guide.split("## 2. Confirm setup once")[1]!.split("## 3.")[0]!;
    expect(setupStep).toContain("commit the accepted setup changes");
    expect(setupStep).toContain("Keep unrelated edits separate");
  });

  it("labels the terminal illustration without inventing a successful run", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    expect(readme).toContain("Example task brief:");
    expect(readme).not.toContain("(illustrative excerpt)");
    expect(readme).toContain(
      '`context "<task>"` is read-only. It does not start a task or run checks.',
    );
    expect(readme).not.toContain("improve reviewer decision safety");
    const png = await readFile(path.resolve("docs/assets/noxroot-terminal.png"));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(1264);
    expect(png.readUInt32BE(20)).toBe(861);
  });

  it("documents the application-agent framework boundary", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    expect(readme).toContain("Application-agent frameworks are detected project architectures");
    expect(readme).toMatch(/runtime sessions,\s+state, memory, and\s+user data/);
  });

  it("separates durable knowledge, temporary task state, and external work ledgers", async () => {
    const architecture = await readFile(path.resolve("docs", "architecture.md"), "utf8");
    const prose = architecture.replace(/\s+/g, " ");
    expect(prose).toContain("Project memory is durable repository knowledge.");
    expect(prose).toContain(
      "Noxroot neither imports their logs into project memory nor treats them as repository-development coordinators.",
    );
    expect(prose).toContain("preview its exact configuration");
    expect(prose).toContain("remove only Noxroot-owned entries");
    expect(prose).toContain("fail open");
    expect(prose).toContain("let `doctor` verify");
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
    const assets = ["noxroot-logo.svg", "noxroot-terminal.png"];
    expect((await readdir(path.resolve("docs", "assets"))).sort()).toEqual(assets);
    for (const asset of assets.filter((name) => name.endsWith(".svg"))) {
      const svg = await readFile(path.resolve("docs", "assets", asset), "utf8");
      expect(svg).toContain("<svg");
      expect(svg).toContain('role="img"');
      expect(svg).toContain("aria-labelledby=");
      expect(svg).toContain("<title");
      expect(svg).toContain("<desc");
    }
    const logo = await readFile(path.resolve("docs/assets/noxroot-logo.svg"), "utf8");
    expect(logo).toContain('viewBox="0 0 1600 440"');
    expect(logo).toContain("Noxroot owl mark");
    expect(readme).toContain('src="docs/assets/noxroot-terminal.png"');
    expect(readme).toContain('width="800"');
    expect(readme).toContain(".noxroot/skills/verify-change/SKILL.md");
    expect(readme).toContain(".noxroot/local/runs/*.json");
    expect(readme).not.toContain("—");
    expect(readme).not.toMatch(
      /auto-documenting|self-training|autonomous team|Obsidian integration|vault system|self-improving AI/i,
    );
  });
});
