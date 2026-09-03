import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "typescript");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "noxroot-package-smoke-"));
const npmCache = path.join(temporaryRoot, "npm-cache");

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
  await writeFile(
    path.join(installRoot, "package.json"),
    `${JSON.stringify({ name: "noxroot-installed-smoke", private: true })}\n`,
  );
  npm(["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"], installRoot);

  const installedPackage = path.join(installRoot, "node_modules", "noxroot");
  for (const requiredFile of [
    "README.md",
    "docs/commands.md",
    "docs/configuration.md",
    "docs/architecture.md",
    "docs/adapters.md",
    "docs/assets/noxroot-logo.svg",
    "docs/assets/noxroot-workflow.svg",
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
  process.stdout.write(
    `Packed CLI smoke passed on ${process.platform} with a real tarball install.\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
