// Probe native package-manager adoption without weakening configured release-age policies.
// Lockfile-only dependency resolution is NOT a completed coding or build workflow.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { environment, execute, git, save, snapshot } from "./workflow-support.mjs";
const scratch = process.argv[2];
if (!/^\/tmp\/noxroot-workflows-[\w-]+$/.test(scratch ?? ""))
  throw new Error("Supply a prepared acceptance workspace.");
const state = JSON.parse(await readFile(path.join(scratch, "state.json"), "utf8"));
environment.npm_config_cache = path.join(scratch, "cache");
for (const index of [8, 9]) {
  const row = structuredClone(state.repositories[index]);
  assert.equal(path.dirname(row.root), scratch);
  row.method =
    "Native pnpm project-local, lockfile-only installation attempt under the existing package-age policy. No policy exemptions, agent sessions, or full native checks. This is not the README's npx-only path.";
  try {
    const manifest = JSON.parse(await readFile(path.join(row.root, "package.json"), "utf8"));
    assert.match(manifest.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
    row.packageManager = manifest.packageManager;
    const policy = await readFile(path.join(row.root, "pnpm-workspace.yaml"), "utf8");
    row.minimumReleaseAge = Number(policy.match(/^minimumReleaseAge:\s*(\d+)/m)?.[1]);
    const manager = path.join(scratch, `manager-${index}`);
    await mkdir(manager);
    await save(path.join(manager, "package.json"), {
      name: "acceptance-package-manager",
      private: true,
    });
    execute(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", manifest.packageManager],
      manager,
    );
    const binary = path.join(manager, "node_modules/pnpm/bin/pnpm.cjs");
    const before = await snapshot(row.root);
    row.install = execute(
      process.execPath,
      [
        binary,
        "add",
        "--workspace-root",
        "--lockfile-only",
        "--ignore-scripts",
        "--save-exact",
        "--store-dir",
        path.join(scratch, "pnpm-store"),
        "noxroot@0.1.0",
      ],
      row.root,
      { allowFailure: true },
    );
    const after = await snapshot(row.root);
    row.changedPaths = Object.keys({ ...before, ...after }).filter(
      (name) => before[name] !== after[name],
    );
    row.diff = git(row.root, ["diff"]);
    row.status = git(row.root, ["status", "--short"]);
    row.result = row.install.code === 0 ? "dependency-resolution-only" : "native-install-blocked";
  } catch (error) {
    row.result = "preparation-blocked";
    row.error = error.message;
  }
  await save(path.join(scratch, `monorepo-${index}.json`), row);
  console.log(
    `${row.repo}: ${row.result}, exit=${row.install?.code}, age=${row.minimumReleaseAge} minutes`,
  );
}
