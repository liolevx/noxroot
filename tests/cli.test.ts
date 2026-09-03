import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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
      "start",
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
    expect(concise.stdout).toContain("Next: npx --yes noxroot@0.1.0 preview --diff");
    expect(concise.stdout).not.toContain("--- /dev/null");
    const exact = await run(["preview", "--diff", "--root", fixture.root]);
    expect(exact.stdout).toContain("Exact proposed changes");
    expect(exact.stdout).toContain("--- /dev/null");
    expect(exact.stdout).toContain("Next: npx --yes noxroot@0.1.0 init");
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

  it("installs only companion capabilities and refuses a second lifecycle", async () => {
    const root = await temporaryDirectory("noxroot-cli-conflict-");
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "tools"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "Use `project-flow` for code changes.\n");
    await writeFile(
      path.join(root, "pyproject.toml"),
      '[project]\nname = "sample"\n[project.scripts]\nproject-flow = "tools.flow:main"\n',
    );
    await writeFile(
      path.join(root, "tools", "flow.py"),
      'workflow = "git worktree implementation worker verification reviewer merge"\n',
    );
    const { stdout, stderr } = await run(["init", "--yes", "--root", root]);

    expect(stdout).toContain("Initialization allowed: yes");
    expect(stdout).toContain("Mode: companion");
    expect(stderr).toBe("");
    const initialized = await hashTree(root);
    process.exitCode = 0;

    const started = await run(["start", "change greeting", "--root", root]);
    expect(started.stdout).toContain("Noxroot lifecycle is disabled for this repository");
    expect(process.exitCode).toBe(3);
    expect(await hashTree(root)).toBe(initialized);

    for (const args of [
      ["run", "change greeting", "--dry-run", "--root", root],
      ["finish", "--root", root],
      ["learn", "--task", "missing", "--root", root],
    ]) {
      process.exitCode = 0;
      const refused = await run(args);
      expect(refused.stdout).toMatch(/Noxroot (?:lifecycle|learning) is disabled/);
      expect(process.exitCode).toBe(3);
      expect(await hashTree(root)).toBe(initialized);
    }
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
