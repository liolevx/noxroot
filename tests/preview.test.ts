import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { previewRepository } from "../src/core/preview.js";
import { scanRepository } from "../src/detection/scan.js";
import { renderPreview } from "../src/output.js";
import {
  fileExists,
  fixtureCopy,
  fixtures,
  hashTree,
  makeEmptyGit,
  temporaryDirectory,
} from "./helpers.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((operation) => operation()));
});

describe("read-only preview", () => {
  it("leaves every committed fixture byte-for-byte unchanged", async () => {
    const entries = await (
      await import("node:fs/promises")
    ).readdir(fixtures, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const fixture = await fixtureCopy(entry.name);
      cleanup.push(fixture.cleanup);
      const before = await hashTree(fixture.root);
      await previewRepository(fixture.root);
      expect(await hashTree(fixture.root), entry.name).toBe(before);
    }
  });

  it("recognizes an empty Git repository without inventing an application", async () => {
    const root = await temporaryDirectory();
    cleanup.push(async () =>
      (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
    );
    await makeEmptyGit(root);
    const result = await previewRepository(root);
    expect(result.profile.git).toBe(true);
    expect(result.profile.empty).toBe(true);
    expect(result.profile.evidence.some((item) => item.claim === "Git repository")).toBe(true);
    expect(
      result.profile.evidence.some(
        (item) => item.claim === "Git worktree cleanliness" && item.status === "unknown",
      ),
    ).toBe(true);
  });
  it("bootstraps an empty directory without inventing architecture", async () => {
    const root = await temporaryDirectory();
    cleanup.push(async () =>
      (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
    );
    const result = await previewRepository(root);
    expect(result.profile.empty).toBe(true);
    expect(result.proposedFiles.map((file) => file.path)).toEqual([
      "AGENTS.md",
      ".noxroot/config.yml",
      ".noxroot/knowledge/INDEX.md",
    ]);
    expect(result.proposedFiles.some((file) => file.path.includes("architecture"))).toBe(false);
    expect(result.capabilities.find((item) => item.id === "task-routes")?.decision).toBe(
      "not-assessed",
    );
    expect(result.capabilities.find((item) => item.id === "task-orchestration")?.decision).toBe(
      "not-assessed",
    );
    expect(renderPreview({ ...result, profile: { ...result.profile, empty: false } })).toContain(
      "Context only",
    );
    expect(renderPreview(result)).toContain("Mode\n  Setup only");
    expect(result.unknowns).toContain("Product intent");
    expect(result.contextEstimate.defaultBytes).toBeGreaterThan(0);
    expect(result.setupImpact).toEqual(
      expect.objectContaining({
        createdFiles: 3,
        patchedFiles: 0,
        referencedFiles: 0,
      }),
    );
    expect(result.setupImpact.netLines).toBeGreaterThan(0);
    expect(result.setupImpact.documentationNetLines).toBeGreaterThan(0);
  });

  it("detects a TypeScript project and candidates without executing them", async () => {
    const fixture = await fixtureCopy("typescript");
    cleanup.push(fixture.cleanup);
    const marker = path.join(fixture.root, "executed.txt");
    const manifest = JSON.parse(
      await readFile(path.join(fixture.root, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };
    manifest.scripts.test = `node -e "require('fs').writeFileSync('${marker.replaceAll("\\", "\\\\")}', 'bad')"`;
    await writeFile(path.join(fixture.root, "package.json"), JSON.stringify(manifest));
    const before = await hashTree(fixture.root);
    const result = await previewRepository(fixture.root);
    const after = await hashTree(fixture.root);
    expect(after).toBe(before);
    expect(await fileExists(marker)).toBe(false);
    expect(result.profile.evidence.some((item) => item.claim === "TypeScript source")).toBe(true);
    expect(result.profile.candidateCommands.map((command) => command.id)).toContain("test");
    expect(result.profile.candidateCommands.map((command) => command.id)).not.toContain("format");
    expect(result.trust).toEqual({
      repositoryFilesChanged: 0,
      repositoryCommandsExecuted: 0,
      agentCallsMade: 0,
      networkRequestsMade: 0,
    });
  });

  it("discovers a non-mutating format check instead of a formatting writer", async () => {
    const root = await temporaryDirectory();
    cleanup.push(async () =>
      (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
    );
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        packageManager: "npm@11.0.0",
        scripts: { format: "prettier --write .", "format:check": "prettier --check ." },
      }),
    );
    const result = await scanRepository(root);
    expect(result.candidateCommands).toEqual([
      {
        id: "format-check",
        executable: "npm",
        args: ["run", "format:check"],
        cwd: ".",
        source: "package.json scripts.format:check",
        appliesTo: ["**/*"],
      },
    ]);
  });

  it("does not read or print suspected secret contents", async () => {
    const fixture = await fixtureCopy("secrets");
    cleanup.push(fixture.cleanup);
    const result = await previewRepository(fixture.root);
    const output = renderPreview(result);
    expect(result.profile.suspectedSecrets).toEqual([".env", "credentials.json"]);
    expect(output).not.toContain("never-print-this-value");
    expect(output).not.toContain("never-print-this-credential");
  });

  it("skips generated directories", async () => {
    const fixture = await fixtureCopy("ignored-generated");
    cleanup.push(fixture.cleanup);
    const result = await scanRepository(fixture.root);
    expect(result.files).not.toContain("dist/generated.js");
  });

  it("respects repository ignore rules", async () => {
    const root = await temporaryDirectory();
    cleanup.push(async () =>
      (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
    );
    await mkdir(path.join(root, "ignored"));
    await writeFile(path.join(root, ".gitignore"), "ignored/\n*.private\n");
    await writeFile(path.join(root, "ignored", "source.ts"), "outside scan");
    await writeFile(path.join(root, "notes.private"), "outside scan");
    const result = await scanRepository(root);
    expect(result.files).toEqual([".gitignore"]);
  });

  it("reports multiple root agent instruction sources as a conflict", async () => {
    const fixture = await fixtureCopy("conflicting-instructions");
    cleanup.push(fixture.cleanup);
    const result = await previewRepository(fixture.root);
    expect(
      result.conflicts.some((item) => item.includes("Multiple root agent instruction sources")),
    ).toBe(true);
  });

  it("does not promote fixture or Noxroot-owned documents to project architecture conflicts", async () => {
    const root = await temporaryDirectory();
    cleanup.push(async () =>
      (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
    );
    await mkdir(path.join(root, "docs"), { recursive: true });
    await mkdir(path.join(root, ".noxroot", "knowledge"), { recursive: true });
    await mkdir(path.join(root, "tests", "fixtures", "sample"), { recursive: true });
    await writeFile(path.join(root, "docs", "architecture.md"), "# Canonical architecture\n");
    await writeFile(
      path.join(root, ".noxroot", "knowledge", "architecture.md"),
      "# Noxroot routing mirror\n",
    );
    await writeFile(
      path.join(root, "tests", "fixtures", "sample", "ARCHITECTURE.md"),
      "# Fixture architecture\n",
    );
    const result = await previewRepository(root);
    expect(result.conflicts.some((item) => item.includes("Multiple architecture"))).toBe(false);
    expect(result.profile.documents.map((item) => item.path)).toContain("docs/architecture.md");
  });

  it.each([
    { manager: "npm", evidence: "package-lock.json", args: ["run", "test"] },
    { manager: "pnpm", evidence: "packageManager", args: ["run", "test"] },
    { manager: "yarn", evidence: "yarn.lock", args: ["test"] },
    { manager: "bun", evidence: "bun.lock", args: ["run", "test"] },
  ])(
    "discovers $manager verification commands from authoritative evidence",
    async (fixtureCase) => {
      const root = await temporaryDirectory();
      cleanup.push(async () =>
        (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
      );
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          name: `${fixtureCase.manager}-fixture`,
          ...(fixtureCase.evidence === "packageManager"
            ? { packageManager: `${fixtureCase.manager}@1.0.0` }
            : {}),
          scripts: { test: "fixture test command" },
        }),
      );
      if (fixtureCase.evidence !== "packageManager") {
        await writeFile(path.join(root, fixtureCase.evidence), "fixture lockfile");
      }
      const result = await scanRepository(root);
      expect(result.packageManager.name).toBe(fixtureCase.manager);
      expect(result.packageManager.status).toBe("confirmed");
      expect(result.candidateCommands).toEqual([
        expect.objectContaining({
          id: "test",
          executable: fixtureCase.manager,
          args: fixtureCase.args,
        }),
      ]);
    },
  );

  it("does not guess a package manager when evidence is missing or conflicting", async () => {
    for (const conflicting of [false, true]) {
      const root = await temporaryDirectory();
      cleanup.push(async () =>
        (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
      );
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "manager-fixture", scripts: { test: "fixture" } }),
      );
      if (conflicting) {
        await writeFile(path.join(root, "package-lock.json"), "{}");
        await writeFile(path.join(root, "yarn.lock"), "fixture");
      }
      const result = await scanRepository(root);
      expect(result.packageManager.status).toBe(conflicting ? "conflicting" : "unknown");
      expect(result.candidateCommands).toEqual([]);
    }
  });

  it("uses the declared workspace package manager at the repository root", async () => {
    const fixture = await fixtureCopy("monorepo");
    cleanup.push(fixture.cleanup);
    const result = await scanRepository(fixture.root);
    expect(result.packageManager).toEqual({
      name: "pnpm",
      status: "confirmed",
      sources: ["package.json packageManager"],
      detail: "Declared package manager is pnpm.",
    });
    expect(result.candidateCommands[0]).toEqual(
      expect.objectContaining({ executable: "pnpm", args: ["run", "test"] }),
    );
  });

  it("uses path-qualified command ids when nested project basenames repeat", async () => {
    const root = await temporaryDirectory();
    cleanup.push(async () =>
      (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
    );
    for (const directory of ["basics/demo", "seo/demo"]) {
      await mkdir(path.join(root, directory), { recursive: true });
      await writeFile(
        path.join(root, directory, "package.json"),
        JSON.stringify({ name: directory, scripts: { build: "fixture build" } }),
      );
      await writeFile(path.join(root, directory, "package-lock.json"), "{}\n");
    }

    const result = await scanRepository(root);
    expect(result.candidateCommands.map((command) => command.id)).toEqual([
      "basics-demo-build",
      "seo-demo-build",
    ]);
    expect(new Set(result.candidateCommands.map((command) => command.id)).size).toBe(
      result.candidateCommands.length,
    );
  });

  it("refuses to configure an independent example collection as one application", async () => {
    const root = await temporaryDirectory("noxroot-example-collection-");
    cleanup.push(async () =>
      (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
    );
    await writeFile(
      path.join(root, "README.md"),
      "# Web course\n\nA collection of lessons and starter projects.\n",
    );
    for (const directory of [
      "lessons/01-routing",
      "lessons/02-data",
      "examples/starter",
      "examples/final",
    ]) {
      await mkdir(path.join(root, directory), { recursive: true });
      await writeFile(
        path.join(root, directory, "package.json"),
        JSON.stringify({ name: directory, scripts: { build: "next build" } }),
      );
    }

    const result = await previewRepository(root);

    expect(result.profile.evidence).toContainEqual(
      expect.objectContaining({ claim: "Independent example collection" }),
    );
    expect(result.initializationAllowed).toBe(false);
    expect(result.proposedFiles).toEqual([]);
    expect(result.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "task-routes", decision: "not-assessed" }),
        expect.objectContaining({ id: "verification-policy", decision: "not-assessed" }),
        expect.objectContaining({ id: "task-orchestration", decision: "not-assessed" }),
      ]),
    );
    expect(renderPreview(result)).toContain("Select one project with --root before initializing.");
  });

  it("aggregates repeated architecture evidence across a monorepo", async () => {
    const root = await temporaryDirectory();
    cleanup.push(async () =>
      (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
    );
    for (const directory of ["apps/admin", "apps/site", "packages/ui"]) {
      await mkdir(path.join(root, directory, "src"), { recursive: true });
      await writeFile(
        path.join(root, directory, "package.json"),
        JSON.stringify({ name: directory, dependencies: { react: "19.0.0" } }),
      );
      await writeFile(path.join(root, directory, "src", "App.tsx"), "export const App = 1;\n");
    }

    const result = await scanRepository(root);
    const node = result.evidence.filter((item) => item.claim === "Node.js project");
    const web = result.evidence.filter((item) => item.claim === "User-facing web application");
    expect(node).toHaveLength(1);
    expect(node[0]?.sources).toHaveLength(3);
    expect(web).toHaveLength(1);
    expect(web[0]?.sources).toContain("apps/site/package.json");
  });

  it("discovers nested Node and Python projects with scoped checks from manifests and CI", async () => {
    const root = await temporaryDirectory();
    cleanup.push(async () =>
      (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
    );
    await mkdir(path.join(root, "web", "components"), { recursive: true });
    await mkdir(path.join(root, "engine", "src"), { recursive: true });
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(
      path.join(root, "web", "package.json"),
      JSON.stringify({
        dependencies: { next: "16.0.0", react: "19.0.0" },
        scripts: {
          typecheck: "tsc --noEmit",
          lint: "eslint .",
          build: "next build",
          test: "npm run build && node --test",
        },
      }),
    );
    await writeFile(path.join(root, "web", "package-lock.json"), "{}\n");
    await writeFile(
      path.join(root, "web", "components", "App.tsx"),
      "export const App = () => <main />;\n",
    );
    await writeFile(path.join(root, "engine", "pyproject.toml"), "[project]\nname='engine'\n");
    await writeFile(path.join(root, "engine", "src", "app.py"), "value = 1\n");
    await writeFile(
      path.join(root, ".github", "workflows", "ci.yml"),
      `jobs:
  engine:
    defaults:
      run:
        working-directory: engine
    steps:
      - name: ruff
        run: uv run ruff check .
      - name: mypy
        run: uv run mypy --strict src
      - name: pytest
        run: uv run pytest -q
  focused:
    steps:
      - name: focused pytest
        working-directory: engine
        run: python -m pytest tests/test_sic.py
  unsafe:
    steps:
      - name: matrix pytest
        working-directory: \${{ matrix.directory }}
        run: python -m pytest
`,
    );

    const result = await previewRepository(root);
    expect(result.profile.evidence).toContainEqual(
      expect.objectContaining({ claim: "Node.js project", sources: ["web/package.json"] }),
    );
    expect(result.profile.evidence).toContainEqual(
      expect.objectContaining({ claim: "Python project", sources: ["engine/pyproject.toml"] }),
    );
    expect(result.profile.packageManager).toMatchObject({
      name: "npm",
      status: "confirmed",
      sources: ["web/package-lock.json"],
    });
    expect(result.profile.candidateCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "web-typecheck", cwd: "web", appliesTo: ["web/**"] }),
        expect.objectContaining({ id: "web-lint", cwd: "web", appliesTo: ["web/**"] }),
        expect.objectContaining({ id: "web-test", cwd: "web", appliesTo: ["web/**"] }),
        expect.objectContaining({
          id: "engine-ruff",
          executable: "uv",
          args: ["run", "ruff", "check", "."],
          cwd: "engine",
          appliesTo: ["engine/**"],
        }),
        expect.objectContaining({ id: "engine-mypy", cwd: "engine" }),
        expect.objectContaining({ id: "engine-pytest", cwd: "engine" }),
        expect.objectContaining({
          id: "engine-focused-pytest",
          executable: "python",
          cwd: "engine",
        }),
      ]),
    );
    expect(result.profile.candidateCommands.map((command) => command.id)).not.toContain(
      "matrix-pytest",
    );
    expect(result.profile.candidateCommands.map((command) => command.id)).not.toContain(
      "web-build",
    );
    expect(result.modules.find((item) => item.id === "product-ux")?.status).toBe("recommended");
    expect(result.modules.find((item) => item.id === "browser-qa")?.status).toBe("not applicable");
    const routes = result.proposedFiles.find(
      (item) => item.path === ".noxroot/routes.yml",
    )?.content;
    expect(routes).toContain("web/**");
    expect(routes).toContain("engine/**");
    expect(routes?.match(/- web\/\*\*/g)).toHaveLength(1);
    expect(routes?.match(/- engine\/\*\*/g)).toHaveLength(1);
  });

  it("does not promote embedded test fixtures into live nested projects", async () => {
    const root = await temporaryDirectory();
    cleanup.push(async () =>
      (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
    );
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ packageManager: "npm@11.0.0", scripts: { test: "node --test" } }),
    );
    await mkdir(path.join(root, "tests", "fixtures", "sample"), { recursive: true });
    await writeFile(
      path.join(root, "tests", "fixtures", "sample", "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { build: "fixture" } }),
    );
    await writeFile(
      path.join(root, "tests", "fixtures", "sample", "pyproject.toml"),
      "[project]\nname='fixture'\n",
    );

    const result = await previewRepository(root);
    expect(result.profile.candidateCommands.map((command) => command.id)).toEqual(["test"]);
    expect(result.profile.evidence).not.toContainEqual(
      expect.objectContaining({ sources: ["tests/fixtures/sample/package.json"] }),
    );
    expect(result.profile.evidence).not.toContainEqual(
      expect.objectContaining({ sources: ["tests/fixtures/sample/pyproject.toml"] }),
    );
  });

  it("indexes architecture domain documents without treating their coexistence as a conflict", async () => {
    const root = await temporaryDirectory();
    cleanup.push(async () =>
      (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
    );
    await mkdir(path.join(root, "architecture"), { recursive: true });
    await writeFile(path.join(root, "ARCHITECTURE.md"), "# System\n");
    await writeFile(path.join(root, "architecture", "README.md"), "# Overview\n");
    await writeFile(path.join(root, "architecture", "frontend.md"), "# Frontend\n");
    await writeFile(path.join(root, "architecture", "contracts.md"), "# Contracts\n");

    const result = await previewRepository(root);
    expect(result.conflicts).not.toContain(
      "Multiple architecture documents require reconciliation",
    );
    const index = result.proposedFiles.find(
      (item) => item.path === ".noxroot/knowledge/INDEX.md",
    )?.content;
    expect(index).toContain("Architecture overview");
    expect(index).toContain("Frontend architecture");
    expect(index).toContain("Contracts architecture");
  });

  it("marks existing Playwright as applicable without installing browser tooling", async () => {
    const fixture = await fixtureCopy("browser");
    cleanup.push(fixture.cleanup);
    const result = await previewRepository(fixture.root);
    expect(result.modules.find((item) => item.id === "browser-qa")?.status).toBe("recommended");
    expect(result.modules.find((item) => item.id === "product-ux")?.status).toBe("not applicable");
  });

  it("detects a user-facing product independently from Playwright", async () => {
    const fixture = await fixtureCopy("frontend");
    cleanup.push(fixture.cleanup);
    const result = await previewRepository(fixture.root);
    expect(result.profile.evidence).toContainEqual(
      expect.objectContaining({ claim: "User-facing web application" }),
    );
    expect(result.modules.find((item) => item.id === "product-ux")?.status).toBe("recommended");
    expect(result.modules.find((item) => item.id === "browser-qa")?.status).toBe("not applicable");
    expect(result.proposedFiles.map((item) => item.path)).toContain(
      ".noxroot/skills/product-ux-review/SKILL.md",
    );
  });

  it("does not promote a host repository from frontend code inside a test fixture", async () => {
    const root = await temporaryDirectory();
    cleanup.push(async () =>
      (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
    );
    await mkdir(path.join(root, "tests", "fixtures", "demo"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "cli-with-fixtures" }));
    await writeFile(
      path.join(root, "tests", "fixtures", "demo", "App.tsx"),
      "export function App() { return <main>Fixture</main>; }\n",
    );

    const result = await previewRepository(root);
    expect(result.profile.evidence).not.toContainEqual(
      expect.objectContaining({ claim: "User-facing web application" }),
    );
    expect(result.modules.find((item) => item.id === "product-ux")?.status).toBe("not applicable");
  });

  it("does not promote a host repository from a nested playground application", async () => {
    const root = await temporaryDirectory();
    cleanup.push(async () =>
      (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
    );
    await writeFile(path.join(root, "Cargo.toml"), "[package]\nname='host'\nversion='0.1.0'\n");
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "lib.rs"), "pub fn parse() {}\n");
    await mkdir(path.join(root, "playground", "web", "src"), { recursive: true });
    await writeFile(
      path.join(root, "playground", "web", "package.json"),
      JSON.stringify({ name: "playground", dependencies: { react: "19.0.0" } }),
    );
    await writeFile(
      path.join(root, "playground", "web", "src", "App.tsx"),
      "export const App = () => <main />;\n",
    );

    const result = await previewRepository(root);
    expect(result.profile.evidence).not.toContainEqual(
      expect.objectContaining({ claim: "User-facing web application" }),
    );
    expect(result.modules.find((item) => item.id === "product-ux")?.status).toBe("not applicable");
    expect(result.proposedFiles.map((item) => item.path)).not.toContain(
      ".noxroot/skills/product-ux-review/SKILL.md",
    );
  });

  it("never follows a symlink escape", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory("noxroot-outside-");
    cleanup.push(async () =>
      (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
    );
    cleanup.push(async () =>
      (await import("node:fs/promises")).rm(outside, { recursive: true, force: true }),
    );
    await writeFile(path.join(outside, "private.txt"), "outside-secret");
    try {
      await symlink(outside, path.join(root, "escape"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const result = await scanRepository(root);
    expect(result.blockedSymlinks).toEqual(["escape"]);
    expect(result.files).not.toContain("escape/private.txt");
  });

  it("is deterministic after documented timing is normalized", async () => {
    const fixture = await fixtureCopy("javascript");
    cleanup.push(fixture.cleanup);
    const first = await previewRepository(fixture.root);
    const second = await previewRepository(fixture.root);
    first.profile.stats.durationMs = 0;
    second.profile.stats.durationMs = 0;
    expect(second).toEqual(first);
    expect(renderPreview(second)).toBe(renderPreview(first));
  });

  it("reports bounded inspection limits instead of extrapolating", async () => {
    const root = await temporaryDirectory();
    cleanup.push(async () =>
      (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
    );
    await mkdir(path.join(root, "src"));
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        writeFile(path.join(root, "src", `${index}.ts`), "export {};"),
      ),
    );
    const result = await scanRepository(root, { limits: { maxFiles: 2 } });
    expect(result.stats.incompleteReasons).toContain("file limit reached (2)");
    expect(result.files).toHaveLength(2);
  });
});
