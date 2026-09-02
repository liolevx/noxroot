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
    expect(result.unknowns).toContain("Product intent");
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

  it("marks existing Playwright as applicable without installing browser tooling", async () => {
    const fixture = await fixtureCopy("browser");
    cleanup.push(fixture.cleanup);
    const result = await previewRepository(fixture.root);
    expect(result.modules.find((item) => item.id === "browser-qa")?.status).toBe("recommended");
    expect(result.modules.find((item) => item.id === "product-ux")?.status).toBe("optional");
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
