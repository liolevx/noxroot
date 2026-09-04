import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProcess } from "../src/adapters/process.js";
import {
  executeVerification,
  planVerification,
  selectVerification,
} from "../src/verification/index.js";
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

  it.runIf(
    process.platform === "win32" &&
      existsSync(
        path.join(path.dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js"),
      ),
  )(
    "invokes pinned Corepack package managers offline without a command shell on Windows",
    async () => {
      const root = await temporaryDirectory();
      cleanup.push(() => rm(root, { recursive: true, force: true }));
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ packageManager: "pnpm@10.0.0" }),
      );
      const result = await runProcess({
        executable: "pnpm",
        args: ["--version"],
        cwd: root,
        repositoryRoot: root,
        timeoutMs: 15_000,
        env: {
          COREPACK_ENABLE_NETWORK: "0",
          COREPACK_DEFAULT_TO_LATEST: "0",
          COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
          ...(process.env.COREPACK_HOME ? { COREPACK_HOME: process.env.COREPACK_HOME } : {}),
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.stdout.trim()).toBe("10.0.0");
      expect(result.executable).toBe(process.execPath);
      expect(result.args[0]).toMatch(/corepack[\\/]dist[\\/]pnpm\.js$/);
    },
    30_000,
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

  it("records an unavailable approved executable as blocked evidence", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const command = {
      id: "missing",
      executable: "definitely-not-installed-noxroot-fixture",
      args: [],
      cwd: ".",
      timeoutMs: 1_000,
      appliesTo: ["**/*"],
    };
    const results = await executeVerification(root, [command]);
    expect(results[0]?.status).toBe("unavailable");
    expect(results[0]?.evidence.stderr).toContain("ENOENT");
  });

  it("selects affected checks from the pre-work policy snapshot", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, ".noxroot"));
    const policy = path.join(root, ".noxroot", "verification.yml");
    await writeFile(
      policy,
      `version: 1
commands:
  - id: trusted-source
    executable: node
    args: ["--version"]
    cwd: .
    timeoutMs: 1000
    appliesTo: [src/**]
`,
    );
    const trustedSnapshot = await planVerification(root);
    await writeFile(
      policy,
      `version: 1
commands:
  - id: worker-added
    executable: node
    args: ["-e", "process.exit(0)"]
    cwd: .
    timeoutMs: 1000
    appliesTo: ["**/*"]
`,
    );
    expect(
      selectVerification(trustedSnapshot, ["src/index.ts", ".noxroot/verification.yml"]).map(
        (command) => command.id,
      ),
    ).toEqual(["trusted-source"]);
    expect(selectVerification(trustedSnapshot, ["docs/readme.md"])).toEqual([]);
  });
});
