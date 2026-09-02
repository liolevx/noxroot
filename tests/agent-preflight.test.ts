import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preflightCommandAdapter } from "../src/adapters/preflight.js";
import { temporaryDirectory } from "./helpers.js";

const exec = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await temporaryDirectory("noxroot-preflight-");
  cleanup.push(root);
  await exec("git", ["init"], { cwd: root });
  await exec("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Fixture"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  await exec("git", ["add", "README.md"], { cwd: root });
  await exec("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

describe("command-adapter preflight", () => {
  it("reports a missing adapter before worktree creation with retry guidance", async () => {
    const root = await repository();
    const result = await preflightCommandAdapter({
      executable: "definitely-not-installed-noxroot-agent",
      args: ["--literal"],
      cwd: root,
      repositoryRoot: root,
      verification: [],
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: "adapter", status: "failed" }),
    );
    expect(result.retry).toContain("No worktree was created");
  });

  it("runs only an explicitly configured health command and preserves actionable stderr", async () => {
    const root = await repository();
    const result = await preflightCommandAdapter({
      executable: process.execPath,
      args: ["agent-entry.js"],
      cwd: root,
      repositoryRoot: root,
      verification: [
        {
          id: "node-check",
          executable: process.execPath,
          args: ["--version"],
          cwd: ".",
          timeoutMs: 1_000,
          appliesTo: ["**/*"],
        },
      ],
      health: {
        executable: process.execPath,
        args: ["-e", "process.stderr.write('authentication expired'); process.exit(3)"],
        timeoutMs: 5_000,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: "health", status: "failed" }),
    );
    expect(result.diagnostics).toContain("authentication expired");
  });

  it("does not guess a vendor health or authentication command", async () => {
    const root = await repository();
    const result = await preflightCommandAdapter({
      executable: process.execPath,
      args: ["agent-entry.js"],
      cwd: root,
      repositoryRoot: root,
      verification: [],
    });
    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: "health", status: "skipped" }),
    );
  });
});
