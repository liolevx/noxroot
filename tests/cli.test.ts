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

async function run(args: string[], options: { isTTY?: boolean; columns?: number } = {}) {
  let stdout = "";
  let stderr = "";
  const program = createProgram({
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
    isTTY: options.isTTY ?? false,
    columns: options.columns ?? 80,
  });
  try {
    await program.parseAsync(["node", "noxroot", ...args]);
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
  }
  return { stdout, stderr };
}

describe("CLI contracts", () => {
  it("shows the compact Noxroot wordmark only at the interactive entry point", async () => {
    const interactive = await run(["--no-color"], { isTTY: true });
    expect(interactive.stdout).toContain("█▄ █  █▀█  ▀▄▀  █▀█  █▀█  █▀█  ▀█▀");
    expect(interactive.stdout).toContain("█ ▀█  █▄█  █ █  █▀▄  █▄█  █▄█   █");
    expect(interactive.stdout).toContain("◆ 0.1.0");
    expect(interactive.stdout).toContain("Project memory and verification for coding agents.");
    expect(interactive.stdout).toContain(
      "A CLI for task context, project checks, and reusable documentation.",
    );
    expect(interactive.stdout).toContain("noxroot preview");

    const piped = await run([]);
    expect(piped.stdout).toContain("Usage: noxroot [options] [command]");
    expect(piped.stdout).not.toContain("◆");

    const narrow = await run(["--no-color"], { isTTY: true, columns: 44 });
    expect(narrow.stdout).toContain("NOXROOT ◆ 0.1.0");
    expect(narrow.stdout).not.toContain("█▄ █");
  });

  it("shows the small mark for interactive setup but not routine commands", async () => {
    const root = await temporaryDirectory("noxroot-terminal-mark-");
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const initialized = await run(["init", "--yes", "--no-color", "--root", root], {
      isTTY: true,
    });
    expect(initialized.stdout).toContain("NOXROOT ◆ setup");

    const preview = await run(["preview", "--no-color", "--root", root], { isTTY: true });
    expect(preview.stdout).not.toContain("◆");
  });

  it("uses color only for interactive human output", async () => {
    const fixture = await fixtureCopy("typescript");
    cleanup.push(fixture.cleanup);
    const previousNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      const interactive = await run(["preview", "--root", fixture.root], { isTTY: true });
      expect(interactive.stdout).toContain("\u001b[");

      const plain = await run(["preview", "--no-color", "--root", fixture.root], {
        isTTY: true,
      });
      expect(plain.stdout).not.toContain("\u001b[");

      const piped = await run(["preview", "--root", fixture.root]);
      expect(piped.stdout).not.toContain("\u001b[");
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
    }
  });

  it("keeps the concise preview readable in a narrow terminal", async () => {
    const fixture = await fixtureCopy("nextjs");
    cleanup.push(fixture.cleanup);
    const { stdout } = await run(["preview", "--no-color", "--root", fixture.root], {
      isTTY: true,
      columns: 40,
    });

    expect(stdout).toContain("Detected\n  Node.js · Web application");
    expect(stdout).toContain("TypeScript");
    expect(stdout).toContain("\n  npm\n");
  });

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
    expect(concise.stdout).toContain("NOXROOT  preview");
    expect(concise.stdout).toContain("Detected\n  Node.js · TypeScript · npm");
    expect(concise.stdout).toContain("Add\n  Project knowledge");
    expect(concise.stdout).toContain("Not assessed\n  Product and UX guidance");
    expect(concise.stdout).toMatch(
      /Setup impact\n {2}\d+ create · \d+ managed patch · \d+ existing reference\n {2}\+\d+ net lines · \+\d+ documentation lines/,
    );
    expect(concise.stdout).toContain(
      "No files changed. No project commands or agents ran. No network requests were made.",
    );
    expect(concise.stdout).toContain("Next\n  npx --yes noxroot@0.1.0 preview --diff");
    expect(concise.stdout).not.toContain("Applicable modules");
    expect(concise.stdout).not.toContain("Files\n  create AGENTS.md");
    expect(concise.stdout).not.toContain("--- /dev/null");

    const verbose = await run(["preview", "--verbose", "--root", fixture.root]);
    expect(verbose.stdout).toContain("Details");
    expect(verbose.stdout).toContain("Applicable modules");
    expect(verbose.stdout).toContain("create AGENTS.md");

    const exact = await run(["preview", "--diff", "--root", fixture.root]);
    expect(exact.stdout).toContain("Exact proposed changes");
    expect(exact.stdout).toContain("--- /dev/null");
    expect(exact.stdout).toContain("Next\n  npx --yes noxroot@0.1.0 init");
  });

  it("shows the repository pin and running CLI before a read-only sync proposal", async () => {
    const fixture = await fixtureCopy("managed-agents");
    cleanup.push(fixture.cleanup);
    const instructions = await readFile(path.join(fixture.root, "AGENTS.md"), "utf8");
    await writeFile(
      path.join(fixture.root, "AGENTS.md"),
      instructions.replace(
        "Old Noxroot guidance that should be replaced.",
        'Use `npx --yes noxroot@0.0.9 context "<task>"`.',
      ),
    );

    const result = await run(["sync", "--dry-run", "--diff", "--root", fixture.root]);

    expect(result.stdout).toContain("NOXROOT  sync");
    expect(result.stdout).toContain("Repository pin  0.0.9");
    expect(result.stdout).toContain("Running CLI     0.1.0");
    expect(result.stdout).toMatch(/Managed changes [1-9]/);
    expect(result.stdout).toContain("Exact proposed changes");
  });

  it("keeps context compact unless verbose evidence is requested", async () => {
    const fixture = await fixtureCopy("typescript");
    cleanup.push(fixture.cleanup);
    const concise = await run(["context", "change greeting", "--root", fixture.root]);
    expect(concise.stdout).toContain("NOXROOT  task brief");
    expect(concise.stdout).toContain("Task context");
    expect(concise.stdout).not.toMatch(/\d+ of \d+ files/);
    expect(concise.stdout).toContain("Checks");
    expect(concise.stdout).toMatch(/Excluded\n {2}\d+ files left out/);
    expect(concise.stdout).not.toContain("outside the active route candidate pool");

    const verbose = await run(["context", "change greeting", "--verbose", "--root", fixture.root]);
    expect(verbose.stdout).toMatch(/\d+ of \d+ files/);
    expect(verbose.stdout).toContain("Selection reasons");
    expect(verbose.stdout).toContain("Excluded files");
  });

  it("shows exact approved commands and working directories in a compact verification plan", async () => {
    const fixture = await fixtureCopy("nextjs");
    cleanup.push(fixture.cleanup);
    const { stdout } = await run(["verify", "--plan", "--root", fixture.root]);

    expect(stdout).toContain("NOXROOT  check plan");
    expect(stdout).toContain("Scope\n  Entire repository");
    expect(stdout).toContain("Planned");
    expect(stdout).toContain("npm run typecheck · cwd .");
    expect(stdout).toContain("Next\n  npx --yes noxroot@0.1.0 verify");
    expect(stdout).not.toContain("NOXROOT VERIFY PLAN");
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

    expect(stdout).toContain("Initialization: allowed");
    expect(stdout).toContain("Mode\n  Companion");
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
