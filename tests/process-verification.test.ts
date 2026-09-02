import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProcess } from "../src/adapters/process.js";
import { executeVerification, planVerification } from "../src/verification/index.js";
import { temporaryDirectory } from "./helpers.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((operation) => operation())));

describe("safe process execution and verification trust", () => {
  it("uses direct arguments, caps output, and records evidence", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(5000))"],
      cwd: root,
      repositoryRoot: root,
      timeoutMs: 5_000,
      outputLimitBytes: 100,
    });
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBe(100);
    expect(result.outputTruncated).toBe(true);
    expect(result.args).toEqual(["-e", "process.stdout.write('x'.repeat(5000))"]);
  });

  it.runIf(process.platform === "win32")(
    "invokes npm through its JavaScript CLI without a command shell on Windows",
    async () => {
      const root = await temporaryDirectory();
      cleanup.push(() => rm(root, { recursive: true, force: true }));
      const result = await runProcess({
        executable: "npm",
        args: ["--version"],
        cwd: root,
        repositoryRoot: root,
        timeoutMs: 5_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.executable).toBe(process.execPath);
      expect(result.args[0]).toMatch(/npm-cli\.js$/);
    },
  );

  it("rejects process working-directory escapes", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await expect(
      runProcess({
        executable: process.execPath,
        args: ["--version"],
        cwd: path.dirname(root),
        repositoryRoot: root,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("escapes repository");
  });

  it("times out a child process", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      repositoryRoot: root,
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("cancels a child process through an abort signal", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      repositoryRoot: root,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    expect(result.exitCode).not.toBe(0);
  });

  it("plans and executes only confirmed commands relevant to changed paths", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, ".noxroot"));
    await writeFile(
      path.join(root, ".noxroot", "verification.yml"),
      `version: 1
commands:
  - id: source-check
    executable: ${JSON.stringify(process.execPath)}
    args: ["-e", "process.stdout.write('source-ok')"]
    cwd: .
    timeoutMs: 5000
    appliesTo: [src/**]
  - id: docs-check
    executable: ${JSON.stringify(process.execPath)}
    args: ["-e", "process.stdout.write('docs-ok')"]
    cwd: .
    timeoutMs: 5000
    appliesTo: [docs/**]
`,
    );
    const commands = await planVerification(root, ["src/index.ts"]);
    expect(commands.map((command) => command.id)).toEqual(["source-check"]);
    const results = await executeVerification(root, commands);
    expect(results[0]?.status).toBe("passed");
    expect(results[0]?.evidence.stdout).toBe("source-ok");
  });

  it("does not treat a manifest script as approved execution policy", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node -e \"throw new Error('must not run')\"" } }),
    );
    expect(await planVerification(root)).toEqual([]);
  });
});
