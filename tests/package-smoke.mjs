import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "typescript");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "noxroot-package-smoke-"));
const npmCache = path.join(temporaryRoot, "npm-cache");

async function snapshot(root) {
  const files = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else
        files[path.relative(root, file)] = entry.isSymbolicLink() ? "link" : await readFile(file);
    }
  }
  await visit(root);
  return files;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", npm_config_cache: npmCache },
    shell: options.shell ?? false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed with ${result.status}:\n${result.stderr}\n${result.stdout}`,
    );
  }
  return result.stdout;
}

function npm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) return run(process.execPath, [npmCli, ...args], { cwd });
  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd });
}

function installedBinary(installRoot) {
  return path.join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "noxroot.cmd" : "noxroot",
  );
}

function invokeBinary(binary, args, cwd) {
  if (process.platform === "win32") {
    return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "call", binary, ...args], {
      cwd,
    });
  }
  return run(binary, args, { cwd });
}

try {
  const packRoot = path.join(temporaryRoot, "pack");
  const installRoot = path.join(temporaryRoot, "install");
  await mkdir(packRoot);
  await mkdir(installRoot);
  const packed = JSON.parse(
    npm(["pack", "--pack-destination", packRoot, "--json"], repositoryRoot),
  );
  const filename = packed[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not report a tarball filename.");
  const tarball = path.join(packRoot, filename);
  const dependencyTarballs = [];
  for (const dependency of ["commander", "yaml", "zod"]) {
    const dependencyPack = JSON.parse(
      npm(
        [
          "pack",
          path.join(repositoryRoot, "node_modules", dependency),
          "--pack-destination",
          packRoot,
          "--json",
        ],
        repositoryRoot,
      ),
    );
    const dependencyFilename = dependencyPack[0]?.filename;
    if (typeof dependencyFilename !== "string") {
      throw new Error(`npm pack did not report a tarball for ${dependency}.`);
    }
    dependencyTarballs.push(path.join(packRoot, dependencyFilename));
  }
  await writeFile(
    path.join(installRoot, "package.json"),
    `${JSON.stringify({ name: "noxroot-installed-smoke", private: true })}\n`,
  );
  npm(
    [
      "install",
      tarball,
      ...dependencyTarballs,
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    installRoot,
  );

  const installedPackage = path.join(installRoot, "node_modules", "noxroot");
  for (const requiredFile of [
    "README.md",
    "docs/commands.md",
    "docs/configuration.md",
    "docs/architecture.md",
    "docs/adapters.md",
    "docs/assets/noxroot-logo.svg",
    "docs/assets/noxroot-terminal.png",
  ]) {
    await readFile(path.join(installedPackage, requiredFile), "utf8");
  }

  const entrypoint = path.join(installedPackage, "dist", "cli.js");
  if ((await readFile(entrypoint, "utf8")).split(/\r?\n/, 1)[0] !== "#!/usr/bin/env node") {
    throw new Error("The packed CLI entrypoint is missing its Node shebang.");
  }
  if (process.platform !== "win32") {
    if (((await stat(entrypoint)).mode & 0o111) === 0) {
      throw new Error("The packed CLI entrypoint is not executable.");
    }
  }

  const binary = installedBinary(installRoot);
  const version = invokeBinary(binary, ["--version"], installRoot).trim();
  if (version !== "0.1.0") throw new Error(`Unexpected installed CLI version: ${version}`);
  const preview = JSON.parse(
    invokeBinary(binary, ["preview", "--root", fixtureRoot, "--json"], installRoot),
  );
  if (preview.kind !== "preview" || preview.trust?.repositoryFilesChanged !== 0) {
    throw new Error("Installed CLI preview did not return the expected read-only JSON contract.");
  }
  const initializedRoot = path.join(temporaryRoot, "initialized-repository");
  await mkdir(initializedRoot);
  await writeFile(
    path.join(initializedRoot, "package.json"),
    `${JSON.stringify({ name: "package-smoke-repository", scripts: { test: "node --test" } })}\n`,
  );
  invokeBinary(binary, ["init", "--yes", "--root", initializedRoot], installRoot);
  const generatedInstructions = await readFile(path.join(initializedRoot, "AGENTS.md"), "utf8");
  if (!generatedInstructions.includes('npx --yes noxroot@0.1.0 start "<task>"')) {
    throw new Error("Packed CLI initialization did not pin its executable lifecycle command.");
  }
  if (!generatedInstructions.includes("npx --yes noxroot@0.1.0 finish")) {
    throw new Error("Packed CLI initialization did not pin its finish command.");
  }
  const initialized = await snapshot(initializedRoot);
  invokeBinary(binary, ["init", "--yes", "--root", initializedRoot], installRoot);
  assert.deepEqual(await snapshot(initializedRoot), initialized, "Repeated init must be a no-op");

  // Synthetic older pin, not a claim that an earlier version was published.
  const agentsPath = path.join(initializedRoot, "AGENTS.md");
  const userPrefix = "# Repository instructions\n\nKeep changes focused.\n\n";
  const userSuffix = "\n## User-owned notes\n\nUse existing documentation.\n";
  const currentInstructions = userPrefix + generatedInstructions + userSuffix;
  await writeFile(agentsPath, currentInstructions.replaceAll("noxroot@0.1.0", "noxroot@0.0.9"));
  await writeFile(path.join(initializedRoot, "user-notes.md"), "Preserve this document.\n");
  const beforeSync = await snapshot(initializedRoot);
  const dryRun = JSON.parse(
    invokeBinary(
      binary,
      ["sync", "--dry-run", "--diff", "--json", "--root", initializedRoot],
      installRoot,
    ),
  );
  assert.deepEqual(dryRun.summary, {
    repositoryVersion: "0.0.9",
    runningVersion: "0.1.0",
    managedChanges: 1,
  });
  const changes = dryRun.preview.proposedFiles.filter((file) => file.action !== "reference");
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, "AGENTS.md");
  assert.equal(changes[0].action, "patch");
  assert.ok(changes[0].patch.includes("noxroot@0.0.9"));
  assert.ok(changes[0].patch.includes("noxroot@0.1.0"));
  assert.deepEqual(await snapshot(initializedRoot), beforeSync, "Sync preview must not write");
  assert.throws(
    () => invokeBinary(binary, ["sync", "--json", "--root", initializedRoot], installRoot),
    /requires --yes/,
  );
  assert.deepEqual(await snapshot(initializedRoot), beforeSync, "Unconfirmed sync must not write");
  invokeBinary(binary, ["sync", "--yes", "--json", "--root", initializedRoot], installRoot);
  assert.deepEqual(
    await snapshot(initializedRoot),
    {
      ...beforeSync,
      "AGENTS.md": Buffer.from(currentInstructions),
    },
    "Sync must change only the managed pin, preserving user content and knowledge",
  );
  const afterSync = await snapshot(initializedRoot);
  const repeated = JSON.parse(
    invokeBinary(
      binary,
      ["sync", "--dry-run", "--diff", "--json", "--root", initializedRoot],
      installRoot,
    ),
  );
  assert.equal(repeated.summary.managedChanges, 0);
  assert.deepEqual(await snapshot(initializedRoot), afterSync);

  const linkedRoot = path.join(temporaryRoot, "linked-repository");
  const outside = path.join(temporaryRoot, "outside");
  await mkdir(linkedRoot);
  await mkdir(outside);
  await symlink(outside, path.join(linkedRoot, ".noxroot"), "junction");
  const linkedBefore = await snapshot(linkedRoot);
  const linkedPreview = JSON.parse(
    invokeBinary(binary, ["preview", "--json", "--root", linkedRoot], installRoot),
  );
  assert.equal(linkedPreview.initializationAllowed, false);
  assert.throws(
    () => invokeBinary(binary, ["init", "--yes", "--json", "--root", linkedRoot], installRoot),
    /failed with 3/,
  );
  assert.deepEqual(await snapshot(linkedRoot), linkedBefore);
  assert.deepEqual(await snapshot(outside), {});

  const guidedRoot = path.join(temporaryRoot, "guided-repository");
  await mkdir(path.join(guidedRoot, "src"), { recursive: true });
  await writeFile(path.join(guidedRoot, "src/value.mjs"), "export const value = 1;\n");
  invokeBinary(binary, ["init", "--yes", "--root", guidedRoot], installRoot);
  await writeFile(
    path.join(guidedRoot, ".noxroot/config.yml"),
    "version: 1\nmodules: [repository-profile, agent-routing, verification, orchestration]\nautonomy: {implementation: 1}\n",
  );
  await writeFile(
    path.join(guidedRoot, ".noxroot/verification.yml"),
    JSON.stringify({
      version: 1,
      commands: [
        {
          id: "syntax",
          executable: process.execPath,
          args: ["--check", "src/value.mjs"],
          cwd: ".",
          timeoutMs: 10000,
          appliesTo: ["src/**"],
        },
      ],
    }),
  );
  run("git", ["init"], { cwd: guidedRoot });
  run("git", ["add", "."], { cwd: guidedRoot });
  run(
    "git",
    [
      "-c",
      "user.name=Noxroot Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "Synthetic baseline",
    ],
    { cwd: guidedRoot },
  );
  const guided = (...args) =>
    JSON.parse(invokeBinary(binary, [...args, "--root", guidedRoot, "--json"], installRoot));
  const started = guided("start", "change value");
  // Keep the caller's raw temp path above: Windows CI may supply an 8.3 alias.
  assert.equal(started.record.repository.root, await realpath(guidedRoot));
  assert.equal(
    path.dirname(path.dirname(path.dirname(started.recordPath))),
    path.join(await realpath(guidedRoot), ".noxroot"),
  );
  assert.ok(started.recordPath.includes(path.join(".noxroot", "local", "runs")));
  assert.equal(run("git", ["status", "--porcelain"], { cwd: guidedRoot }).trim(), "");
  await writeFile(path.join(guidedRoot, "src/value.mjs"), "export const value = ;\n");
  assert.throws(() => guided("finish"), /failed with 4/);
  const failedRecord = JSON.parse(await readFile(started.recordPath, "utf8"));
  assert.equal(failedRecord.status, "failed");
  const continued = guided("start", "change value");
  assert.equal(continued.record.id, started.record.id);
  assert.equal(continued.continued, true);
  await writeFile(path.join(guidedRoot, "src/value.mjs"), "export const value = 2;\n");
  const finished = guided("finish");
  assert.equal(finished.record.status, "completed");
  assert.equal(finished.record.id, started.record.id);
  assert.equal(finished.record.baseline.revision, started.record.baseline.revision);
  assert.deepEqual(finished.record.changedPaths, ["src/value.mjs"]);
  assert.deepEqual(
    (await readdir(path.dirname(started.recordPath))).filter((name) => name.endsWith(".json")),
    [path.basename(started.recordPath)],
  );
  process.stdout.write(
    `Packed CLI smoke passed on ${process.platform}: install, repeated init, managed-pin upgrade, preservation, linked-destination refusal, and start/fail/continue/finish.\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
