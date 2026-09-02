import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(agents).toContain(".noxroot/knowledge/INDEX.md");
    expect(
      await readFile(path.join(fixture.root, ".noxroot", "knowledge", "INDEX.md"), "utf8"),
    ).toContain("../../docs/architecture.md");
    expect(await readFile(path.join(fixture.root, "README.md"), "utf8")).toContain(
      "must be preserved",
    );
    expect((await previewRepository(fixture.root)).proposedFiles).toEqual([]);
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

  it("reuses an equivalent existing entrypoint without patching it", async () => {
    const fixture = await fixtureCopy("equivalent-agents");
    cleanup.push(fixture.cleanup);
    const before = await readFile(path.join(fixture.root, "AGENTS.md"), "utf8");
    const preview = await previewRepository(fixture.root);
    expect(preview.proposedFiles.find((file) => file.path === "AGENTS.md")?.action).toBe(
      "reference",
    );
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
