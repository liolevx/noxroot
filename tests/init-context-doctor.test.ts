import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildContext } from "../src/core/context.js";
import { doctorRepository } from "../src/core/doctor.js";
import { applyProposals } from "../src/core/init.js";
import { previewRepository } from "../src/core/preview.js";
import { buildProposals } from "../src/core/proposals.js";
import { fixtureCopy, temporaryDirectory } from "./helpers.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((operation) => operation())));

describe("initialization, sync safety, context, and doctor", () => {
  it("creates only the minimal empty-repository setup", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const preview = await previewRepository(root);
    const result = await applyProposals(preview);
    expect(result.created).toEqual([
      "AGENTS.md",
      ".noxroot/config.yml",
      ".noxroot/knowledge/INDEX.md",
    ]);
    const instructions = await readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(instructions).toContain("Noxroot's task lifecycle is not enabled");
    expect(instructions).not.toContain("existing repository coordinator remains authoritative");
    const after = await previewRepository(root);
    expect(after.proposedFiles).toEqual([]);
    expect(after.profile.files).not.toContain(".noxroot/knowledge/architecture.md");
  });

  it("adopts existing docs and appends a managed entrypoint without overwriting user content", async () => {
    const fixture = await fixtureCopy("existing-docs");
    cleanup.push(fixture.cleanup);
    const original = await readFile(path.join(fixture.root, "AGENTS.md"), "utf8");
    const preview = await previewRepository(fixture.root);
    expect(preview.proposedFiles.find((file) => file.path === "AGENTS.md")?.action).toBe("patch");
    expect(preview.proposedFiles.find((file) => file.path === "docs/architecture.md")?.action).toBe(
      "reference",
    );
    expect(
      preview.proposedFiles.some((file) => file.path === ".noxroot/knowledge/architecture.md"),
    ).toBe(false);
    await applyProposals(preview);
    const agents = await readFile(path.join(fixture.root, "AGENTS.md"), "utf8");
    expect(agents.startsWith(original)).toBe(true);
    expect(agents).toContain("<!-- noxroot:start -->");
    expect(agents).toContain('run `npx --yes noxroot@0.1.0 start "<task>"` before editing');
    expect(agents).toContain("`npx --yes noxroot@0.1.0 finish` when the change is ready to check");
    expect(agents).toContain("Do not start a task for questions, explanations, reviews");
    expect(agents).toContain(".noxroot/knowledge/INDEX.md");
    expect(
      await readFile(path.join(fixture.root, ".noxroot", "knowledge", "INDEX.md"), "utf8"),
    ).toContain("../../docs/architecture.md");
    expect(await readFile(path.join(fixture.root, "README.md"), "utf8")).toContain(
      "must be preserved",
    );
    const after = await previewRepository(fixture.root);
    expect(after.proposedFiles).toEqual([]);
    expect(after.capabilities.find((item) => item.id === "task-orchestration")).toMatchObject({
      decision: "reuse",
    });
  });

  it("keeps a generated knowledge index bounded when a repository has many referenced documents", async () => {
    const root = await temporaryDirectory("noxroot-index-bounds-");
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "docs"));
    const references: string[] = [];
    for (let index = 0; index < 24; index += 1) {
      const file = `docs/decision-${index}.md`;
      references.push(`[Decision ${index}](${file})`);
      await writeFile(path.join(root, file), `# Decision ${index}\n`);
    }
    await writeFile(
      path.join(root, "AGENTS.md"),
      `# Instructions\n\nProject knowledge: ${references.join(", ")}\n`,
    );
    await writeFile(path.join(root, "package.json"), '{"name":"sample"}\n');

    const preview = await previewRepository(root);
    const index = preview.proposedFiles.find(
      (item) => item.path === ".noxroot/knowledge/INDEX.md",
    )?.content;
    const documentReferences = preview.proposedFiles.filter((item) => item.action === "reference");
    expect((index?.match(/existing repository documentation/g) ?? []).length).toBeLessThanOrEqual(
      12,
    );
    expect(documentReferences.length).toBeLessThanOrEqual(12);
    expect(index).toContain("Additional repository documentation remains in place");
  });

  it("indexes one canonical document from a translated documentation family", async () => {
    const root = await temporaryDirectory("noxroot-translated-docs-");
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    for (const locale of ["en", "fr", "de"]) {
      await mkdir(path.join(root, "docs", locale, "docs", "tutorial"), { recursive: true });
      await writeFile(
        path.join(root, "docs", locale, "docs", "tutorial", "testing.md"),
        `# Testing (${locale})\n`,
      );
    }
    await writeFile(
      path.join(root, "AGENTS.md"),
      [
        "# Instructions",
        "",
        "Testing documentation:",
        "- [English](docs/en/docs/tutorial/testing.md)",
        "- [French](docs/fr/docs/tutorial/testing.md)",
        "- [German](docs/de/docs/tutorial/testing.md)",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(root, "pyproject.toml"), '[project]\nname = "sample"\n');

    const preview = await previewRepository(root);
    const index = preview.proposedFiles.find(
      (item) => item.path === ".noxroot/knowledge/INDEX.md",
    )?.content;
    const references = preview.proposedFiles
      .filter((item) => item.action === "reference")
      .map((item) => item.path);

    expect(index).toContain("../../docs/en/docs/tutorial/testing.md");
    expect(index).not.toContain("../../docs/fr/docs/tutorial/testing.md");
    expect(index).not.toContain("../../docs/de/docs/tutorial/testing.md");
    expect(references).toContain("docs/en/docs/tutorial/testing.md");
    expect(references).not.toContain("docs/fr/docs/tutorial/testing.md");
    expect(references).not.toContain("docs/de/docs/tutorial/testing.md");
  });

  it("updates only an existing managed block and preserves content before and after it", async () => {
    const fixture = await fixtureCopy("managed-agents");
    cleanup.push(fixture.cleanup);
    const before = await readFile(path.join(fixture.root, "AGENTS.md"), "utf8");
    const prefix = before.slice(0, before.indexOf("<!-- noxroot:start -->"));
    const suffix = before.slice(
      before.indexOf("<!-- noxroot:end -->") + "<!-- noxroot:end -->".length,
    );
    const preview = await previewRepository(fixture.root);
    await applyProposals(preview);
    const after = await readFile(path.join(fixture.root, "AGENTS.md"), "utf8");
    expect(after.startsWith(prefix)).toBe(true);
    expect(after.endsWith(suffix)).toBe(true);
    expect(after).not.toContain("Old Noxroot guidance");
    expect(after).toContain("the Noxroot knowledge index");
    expect((await previewRepository(fixture.root)).proposedFiles).toEqual([]);
  });

  it("preserves CRLF bytes outside and inside the appended managed block", async () => {
    const root = await temporaryDirectory("noxroot-crlf-");
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const original = Buffer.from("# Instructions\r\n\r\nKeep this exact.\r\n", "utf8");
    await writeFile(path.join(root, "AGENTS.md"), original);
    await writeFile(path.join(root, "package.json"), '{"name":"sample"}\r\n');

    const preview = await previewRepository(root);
    await applyProposals(preview);
    const after = await readFile(path.join(root, "AGENTS.md"));
    expect(after.subarray(0, original.length)).toEqual(original);
    expect(after.toString("utf8")).not.toMatch(/(?<!\r)\n/);
  });

  it("preserves an equivalent entrypoint when its referenced knowledge is unavailable", async () => {
    const fixture = await fixtureCopy("equivalent-agents");
    cleanup.push(fixture.cleanup);
    const before = await readFile(path.join(fixture.root, "AGENTS.md"), "utf8");
    const preview = await previewRepository(fixture.root);
    expect(preview.proposedFiles.find((file) => file.path === "AGENTS.md")).toBeUndefined();
    expect(preview.capabilities.find((item) => item.id === "project-knowledge")).toMatchObject({
      decision: "not-assessed",
    });
    await applyProposals(preview);
    expect(await readFile(path.join(fixture.root, "AGENTS.md"), "utf8")).toBe(before);
  });

  it("reports conflicting architecture documents instead of choosing one silently", async () => {
    const fixture = await fixtureCopy("conflicting-docs");
    cleanup.push(fixture.cleanup);
    const preview = await previewRepository(fixture.root);
    expect(preview.conflicts).toContain(
      "Multiple architecture documents require reconciliation: ARCHITECTURE.md, docs/architecture.md",
    );
    expect(
      preview.proposedFiles.some((file) => file.path === ".noxroot/knowledge/architecture.md"),
    ).toBe(false);
  });

  it("stops if a target appears after preview", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const preview = await previewRepository(root);
    await writeFile(path.join(root, "AGENTS.md"), "user content");
    await expect(applyProposals(preview)).rejects.toThrow("now exists");
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("user content");
  });

  it("honors disabled modules when constructing an initialization proposal", async () => {
    const fixture = await fixtureCopy("typescript");
    cleanup.push(fixture.cleanup);
    const preview = await previewRepository(fixture.root);
    const modules = preview.modules.map((module) => ({
      ...module,
      status: module.id === "repository-profile" ? ("enabled" as const) : ("disabled" as const),
    }));
    expect((await buildProposals(preview.profile, modules)).map((item) => item.path)).toEqual([
      ".noxroot/config.yml",
    ]);
  });

  it("generates short canonical skills and routes product UX only for applicable work", async () => {
    const fixture = await fixtureCopy("frontend");
    cleanup.push(fixture.cleanup);
    const preview = await previewRepository(fixture.root);
    const modules = preview.modules.map((module) => ({
      ...module,
      status:
        module.id === "product-ux" || module.status === "recommended"
          ? ("enabled" as const)
          : module.status,
    }));
    const proposedFiles = await buildProposals(preview.profile, modules);
    const skillPaths = proposedFiles
      .map((item) => item.path)
      .filter((item) => item.endsWith("/SKILL.md"));
    expect(skillPaths).toEqual([
      ".noxroot/skills/verify-change/SKILL.md",
      ".noxroot/skills/independent-review/SKILL.md",
      ".noxroot/skills/product-ux-review/SKILL.md",
    ]);
    for (const skillPath of skillPaths) {
      const content = proposedFiles.find((item) => item.path === skillPath)?.content ?? "";
      const frontmatter = /^---\n([\s\S]+?)\n---\n/.exec(content)?.[1];
      expect(frontmatter).toBeDefined();
      expect(parse(frontmatter!)).toMatchObject({
        name: path.basename(path.dirname(skillPath)),
      });
      expect(content.length).toBeLessThan(3_500);
    }
    await applyProposals({ ...preview, modules, proposedFiles });
    const backend = await buildContext("repair backend database transaction", fixture.root);
    expect(backend.selected.some((item) => item.path.includes("product-ux-review"))).toBe(false);
    const userInterface = await buildContext("review product UI responsive UX", fixture.root);
    expect(
      userInterface.selected.some(
        (item) => item.path === ".noxroot/skills/product-ux-review/SKILL.md",
      ),
    ).toBe(true);
  });

  it("does not generate a product UX skill for a backend-only repository", async () => {
    const fixture = await fixtureCopy("typescript");
    cleanup.push(fixture.cleanup);
    const preview = await previewRepository(fixture.root);
    expect(preview.proposedFiles.map((item) => item.path)).not.toContain(
      ".noxroot/skills/product-ux-review/SKILL.md",
    );
    expect(preview.proposedFiles.map((item) => item.path)).toContain(
      ".noxroot/skills/verify-change/SKILL.md",
    );
  });

  it("selects relevant context under the configured budget", async () => {
    const fixture = await fixtureCopy("typescript");
    cleanup.push(fixture.cleanup);
    await mkdir(path.join(fixture.root, ".noxroot", "knowledge"), { recursive: true });
    await writeFile(
      path.join(fixture.root, ".noxroot", "config.yml"),
      "version: 1\ncontext:\n  budgetBytes: 600\n",
    );
    await writeFile(
      path.join(fixture.root, ".noxroot", "knowledge", "INDEX.md"),
      "# Index\nRead source only when routed.\n",
    );
    const context = await buildContext("fix greet test", fixture.root);
    expect(context.selected.some((item) => item.path === "src/greet.ts")).toBe(true);
    expect(context.likelyTests).toContain("tests/greet.test.ts");
    expect(context.budget.selectedBytes).toBeLessThanOrEqual(600);
    expect(context.selected.every((item) => !item.path.includes("node_modules"))).toBe(true);
  });

  it("uses only confirmed verification policy in context", async () => {
    const fixture = await fixtureCopy("typescript");
    cleanup.push(fixture.cleanup);
    let context = await buildContext("change greet", fixture.root);
    expect(context.requiredVerification).toEqual([]);
    await mkdir(path.join(fixture.root, ".noxroot"), { recursive: true });
    await writeFile(
      path.join(fixture.root, ".noxroot", "verification.yml"),
      "version: 1\ncommands:\n  - id: test\n    executable: npm\n    args: [test]\n    cwd: .\n    timeoutMs: 120000\n    appliesTo: [src/**]\n",
    );
    context = await buildContext("change greet", fixture.root);
    expect(context.requiredVerification.map((item) => item.id)).toEqual(["test"]);
  });

  it("applies explicit context routes and configured sensitive paths", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, ".noxroot"), { recursive: true });
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "auth.md"), "auth contract");
    await writeFile(path.join(root, "docs", "private.md"), "never select this content");
    await writeFile(
      path.join(root, ".noxroot", "config.yml"),
      "version: 1\nsensitivePaths: [docs/private.md]\n",
    );
    await writeFile(
      path.join(root, ".noxroot", "routes.yml"),
      "version: 1\nroutes:\n  - id: auth\n    match: [auth]\n    include: [docs/auth.md]\n    exclude: []\n",
    );
    const context = await buildContext("change auth flow", root);
    expect(context.selected.find((item) => item.path === "docs/auth.md")?.reasons).toContain(
      "matched an active context route",
    );
    expect(context.selected.some((item) => item.path === "docs/private.md")).toBe(false);
  });

  it("reports path-specific malformed configuration", async () => {
    const fixture = await fixtureCopy("malformed-config");
    cleanup.push(fixture.cleanup);
    const result = await doctorRepository(fixture.root);
    expect(result.healthy).toBe(false);
    expect(result.findings[0]?.code).toBe("invalid-configuration");
    expect(result.findings[0]?.message).toMatch(/version|modules/);
  });

  it("reports stale references, unavailable adapters, module drift, and local-state retention", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, ".git", "noxroot", "runs"), { recursive: true });
    await mkdir(path.join(root, ".noxroot", "knowledge"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Agent\n");
    await writeFile(
      path.join(root, ".noxroot", "config.yml"),
      `version: 1
modules: [repository-profile, verification, browser-qa]
entrypoints: [AGENTS.md]
context: {budgetBytes: 1, documentWarningBytes: 1}
agents:
  default: manual
  adapters:
    manual: {type: manual}
    missing: {type: command, executable: definitely-not-installed, args: []}
retention: {evidenceDays: 30, maximumRuns: 1}
browser: {verificationCommandId: browser-check}
`,
    );
    await writeFile(
      path.join(root, ".noxroot", "verification.yml"),
      "version: 1\ncommands:\n  - id: missing\n    executable: definitely-not-installed\n    args: []\n    cwd: missing\n    timeoutMs: 1000\n    appliesTo: ['**/*']\n",
    );
    await writeFile(
      path.join(root, ".noxroot", "routes.yml"),
      "version: 1\nroutes:\n  - id: stale\n    match: ['**/*']\n    include: [missing.md]\n    exclude: []\n",
    );
    await writeFile(path.join(root, ".noxroot", "knowledge", "INDEX.md"), "# Index\n");
    await writeFile(
      path.join(root, ".noxroot", "knowledge", "orphan.md"),
      "# Old\n\nLast confirmed: 2020-01-01\n",
    );
    const running = path.join(root, ".git", "noxroot", "runs", "running.json");
    await writeFile(running, '{"status":"running"}');
    await writeFile(
      path.join(root, ".git", "noxroot", "runs", "done.json"),
      '{"status":"approved"}',
    );
    await utimes(running, new Date("2020-01-01"), new Date("2020-01-01"));
    const result = await doctorRepository(root);
    const codes = result.findings.map((item) => item.code);
    for (const code of [
      "agent-adapter-unavailable",
      "browser-module-drift",
      "default-context-oversized",
      "knowledge-document-oversized",
      "orphaned-knowledge",
      "stale-knowledge",
      "verification-cwd-missing",
      "verification-executable-unavailable",
      "missing-route-reference",
      "browser-command-missing",
      "run-retention-exceeded",
      "abandoned-run",
    ]) {
      expect(codes).toContain(code);
    }
    expect(result.healthy).toBe(false);
  });
});
