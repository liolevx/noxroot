import { readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CommanderError } from "commander";
import { createProgram } from "../src/cli.js";
import { fixtureCopy, hashTree, temporaryDirectory } from "./helpers.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  process.exitCode = 0;
  await Promise.all(cleanup.splice(0).map((operation) => operation()));
});

async function run(args: string[], isTTY = false) {
  let stdout = "";
  let stderr = "";
  const program = createProgram({
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
    isTTY,
  });
  try {
    await program.parseAsync(["node", "noxroot", ...args]);
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
  }
  return { stdout, stderr };
}

describe("CLI contracts", () => {
  it("provides discoverable help and conventional commands", async () => {
    const { stdout } = await run(["--help"]);
    expect(stdout).toContain("Usage: noxroot [options] [command]");
    for (const command of [
      "preview",
      "init",
      "sync",
      "doctor",
      "context",
      "verify",
      "run",
      "finish",
      "learn",
    ]) {
      expect(stdout).toContain(command);
    }
  });

  it("keeps the CLI version synchronized with package metadata", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    const { stdout } = await run(["--version"]);
    expect(stdout.trim()).toBe(packageJson.version);
  });

  it("keeps preview JSON machine-readable with options after the command", async () => {
    const fixture = await fixtureCopy("javascript");
    cleanup.push(fixture.cleanup);
    const { stdout, stderr } = await run(["preview", "--json", "--root", fixture.root]);
    expect(stderr).toBe("");
    const value = JSON.parse(stdout) as { kind: string; trust: { repositoryFilesChanged: number } };
    expect(value.kind).toBe("preview");
    expect(value.trust.repositoryFilesChanged).toBe(0);
  });

  it("keeps default preview concise and reveals exact patches only with --diff", async () => {
    const fixture = await fixtureCopy("typescript");
    cleanup.push(fixture.cleanup);
    const concise = await run(["preview", "--root", fixture.root]);
    expect(concise.stdout).toContain("Proposed (7): create 7");
    expect(concise.stdout).toContain("Next: noxroot preview --diff");
    expect(concise.stdout).not.toContain("--- /dev/null");
    const exact = await run(["preview", "--diff", "--root", fixture.root]);
    expect(exact.stdout).toContain("Exact proposed changes");
    expect(exact.stdout).toContain("--- /dev/null");
    expect(exact.stdout).toContain("Next: noxroot init");
  });

  it("cancels non-interactive initialization without --yes", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const before = await hashTree(root);
    const { stderr } = await run(["init", "--root", root]);
    expect(stderr).toContain("Initialization cancelled");
    expect(process.exitCode).toBe(3);
    expect(await hashTree(root)).toBe(before);
  });

  it("emits one JSON document for confirmed initialization", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const { stdout, stderr } = await run(["init", "--yes", "--json", "--root", root]);
    expect(stderr).toBe("");
    const value = JSON.parse(stdout) as {
      preview: { proposedFiles: unknown[] };
      applied: { created: string[] };
    };
    expect(value.preview.proposedFiles).toHaveLength(3);
    expect(value.applied.created).toEqual([
      "AGENTS.md",
      ".noxroot/config.yml",
      ".noxroot/knowledge/INDEX.md",
    ]);
  });

  it("makes run --dry-run command-free and write-free", async () => {
    const fixture = await fixtureCopy("typescript");
    cleanup.push(fixture.cleanup);
    const before = await hashTree(fixture.root);
    const { stdout } = await run(["run", "change greeting", "--dry-run", "--root", fixture.root]);
    expect(stdout).toContain("NOXROOT RUN PLAN");
    expect(stdout).toContain('"executes": false');
    expect(await hashTree(fixture.root)).toBe(before);
  });
});
