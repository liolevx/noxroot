// Opt-in Linux acceptance. Input contains inspected, pinned underscore/ and bottle/
// checkouts plus a built old-source/. Never commits or pushes external repositories.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const source = path.resolve(import.meta.dirname, "../..");
const scratch = path.resolve(process.argv[2] ?? ".");
if (process.platform === "win32" || !/^\/tmp\/noxroot-legacy-acceptance-[\w-]+$/.test(scratch))
  throw Error("Use Linux and an explicitly prepared /tmp/noxroot-legacy-acceptance-* directory.");
const env = Object.fromEntries(
  ["PATH", "HOME", "LANG"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
);
Object.assign(env, {
  npm_config_cache: path.join(scratch, "cache"),
  npm_config_audit: "false",
  npm_config_fund: "false",
  PYTHONDONTWRITEBYTECODE: "1",
  GIT_TERMINAL_PROMPT: "0",
});
const report = {
  method:
    "Packed CLIs, separate command processes, operator-driven workflows. Not autonomous agent sessions or registry upgrades.",
  results: [],
};
async function save() {
  await writeFile(path.join(scratch, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
function run(bin, args, cwd, expected = 0) {
  const r = spawnSync(bin, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 8000000,
  });
  const result = {
    code: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? r.error?.message ?? "",
  };
  if (expected !== null)
    assert.equal(
      result.code,
      expected,
      `${bin} ${args.join(" ")}: ${result.stderr || result.stdout}`,
    );
  return result;
}
function git(root, args) {
  return run("git", ["-c", "core.hooksPath=/dev/null", ...args], root).stdout.trim();
}
function nox(cli, root, args, expected = 0) {
  const r = run("node", [cli, ...args, "--root", root, "--json"], root, expected);
  return { ...r, value: JSON.parse(r.stdout) };
}
async function snapshot(root, prefix = "") {
  const result = {};
  for (const e of (await readdir(path.join(root, prefix), { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const p = prefix + e.name;
    if ([".git", "node_modules", "__pycache__"].includes(e.name) || p === ".noxroot/local")
      continue;
    if (e.isDirectory()) Object.assign(result, await snapshot(root, p + "/"));
    else if (e.isFile())
      result[p] = createHash("sha256")
        .update(await readFile(path.join(root, p)))
        .digest("hex");
  }
  return result;
}
async function install(directory, name, deps) {
  const destination = path.join(scratch, name);
  await mkdir(destination);
  const packed = JSON.parse(
    run(
      "npm",
      ["pack", directory, "--ignore-scripts", "--json", "--pack-destination", destination],
      scratch,
    ).stdout,
  )[0];
  await writeFile(
    path.join(destination, "package.json"),
    '{"name":"acceptance-only","private":true}\n',
  );
  run(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-save",
      "--package-lock=false",
      path.join(destination, packed.filename),
      ...deps,
    ],
    destination,
  );
  return {
    cli: path.join(destination, "node_modules/noxroot/dist/cli.js"),
    size: packed.size,
    integrity: packed.integrity,
  };
}
async function policy(root, executable, args, cwd = ".") {
  const command = {
    id: "approved-regression",
    executable,
    args,
    cwd,
    timeoutMs: 30000,
    appliesTo: ["**/*"],
  };
  await writeFile(
    path.join(root, ".noxroot/verification.yml"),
    JSON.stringify({ version: 1, commands: [command] }, null, 2) + "\n",
  );
  return command;
}
async function setup(cli, root) {
  const before = await snapshot(root);
  const preview = nox(cli, root, ["preview"]).value;
  assert.deepEqual(await snapshot(root), before);
  assert.equal(preview.initializationAllowed, true);
  nox(cli, root, ["init", "--yes"]);
  const initialized = await snapshot(root);
  nox(cli, root, ["init", "--yes"]);
  assert.deepEqual(await snapshot(root), initialized);
  return {
    previewReadOnly: true,
    initIdempotent: true,
    capabilities: preview.capabilities,
    proposedFiles: preview.proposedFiles.map(({ path, action }) => ({ path, action })),
    discoveredCommands: preview.profile.candidateCommands,
  };
}
function contextEvidence(value) {
  return {
    selected: value.context.selected.map((f) => f.path),
    budget: value.context.budget,
    confidence: value.context.confidence,
  };
}
async function cycle(cli, root, task, target, failing, passing, stateDirectory) {
  const started = nox(cli, root, ["start", task]).value;
  await writeFile(path.join(root, target), failing);
  const failure = nox(cli, root, ["finish"], 4).value;
  assert.equal(failure.record.status, "failed");
  const continued = nox(cli, root, ["start", task]).value;
  assert.equal(continued.continued, true);
  assert.equal(continued.record.id, started.record.id);
  assert.equal(continued.continuation.verification.status, "current-failed");
  await writeFile(path.join(root, target), passing);
  const stale = nox(cli, root, ["start", task]).value;
  assert.equal(stale.continuation.verification.status, "stale");
  const done = nox(cli, root, ["finish"]).value;
  assert.equal(done.record.id, started.record.id);
  assert.deepEqual(done.record.baseline, started.record.baseline);
  assert.equal(done.record.status, "completed");
  assert.equal((await readdir(stateDirectory)).filter((n) => n.endsWith(".json")).length, 1);
  assert.equal(done.learning.proposals.length, 0);
  return {
    context: contextEvidence(started),
    taskId: started.record.id,
    baseline: started.record.baseline,
    failedExit: 4,
    failureEvidence: failure.record.verification.at(-1),
    continuedSameTask: true,
    verificationInvalidatedAfterEdit: true,
    finishInferred: true,
    finalStatus: done.record.status,
    checks: done.record.verification.at(-1),
    documentationAssessment: done.completion,
    modelCalls: done.record.calls.length,
  };
}

try {
  const deps = [];
  for (const name of ["commander", "yaml", "zod"]) {
    const p = JSON.parse(
      run(
        "npm",
        [
          "pack",
          path.join(source, "node_modules", name),
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          scratch,
        ],
        scratch,
      ).stdout,
    )[0];
    deps.push(path.join(scratch, p.filename));
  }
  const current = await install(source, "current-install", deps);
  const old = await install(path.join(scratch, "old-source"), "old-install", deps);
  report.package = current;
  report.sourceCommit = git(source, ["rev-parse", "HEAD"]);
  report.sourceDiff = git(source, ["diff", "--stat"]);

  const legacy = path.join(scratch, "legacy-project");
  await mkdir(legacy);
  for (const dir of ["src", "test", "docs"]) await mkdir(path.join(legacy, dir));
  await writeFile(
    path.join(legacy, "package.json"),
    '{"name":"legacy-demo","private":true,"scripts":{"test":"node --test test/value.cjs"}}\n',
  );
  await writeFile(
    path.join(legacy, "src/value.cjs"),
    "exports.normalize = value => value.trim();\n",
  );
  await writeFile(
    path.join(legacy, "test/value.cjs"),
    'const assert = require("node:assert/strict");\nassert.equal(require("../src/value.cjs").normalize(" x "), "x");\n',
  );
  await writeFile(
    path.join(legacy, "docs/architecture.md"),
    "# Normalization\n\nTrim surrounding whitespace without changing internal spacing. Keep the existing CommonJS API.\n",
  );
  await writeFile(
    path.join(legacy, "AGENTS.md"),
    "# Team instructions\n\nRead docs/architecture.md before changing normalization.\n",
  );
  await writeFile(
    path.join(legacy, "CLAUDE.md"),
    "# Client instructions\n\nFollow AGENTS.md and preserve the CommonJS API.\n",
  );
  git(legacy, ["init", "-b", "agent/legacy-demo"]);
  const row = { name: "actual-old-CLI-upgrade", setup: await setup(old.cli, legacy) };
  row.approvedCommand = await policy(legacy, "npm", ["test"]);
  git(legacy, ["add", "."]);
  git(legacy, [
    "-c",
    "user.name=Noxroot Acceptance",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Synthetic legacy baseline",
  ]);
  const task = "test normalization preserves internal spaces";
  const started = nox(old.cli, legacy, ["start", task]).value;
  const before = await snapshot(legacy);
  const recordBefore = await readFile(started.recordPath, "utf8");
  const preview = nox(current.cli, legacy, ["sync", "--dry-run", "--diff"]).value;
  row.syncProposed = preview.preview.proposedFiles.filter((f) => f.action !== "reference");
  assert.deepEqual(await snapshot(legacy), before);
  nox(current.cli, legacy, ["sync", "--yes"]);
  const synced = await snapshot(legacy);
  row.syncChanged = Object.keys(synced).filter((p) => synced[p] !== before[p]);
  assert.deepEqual(row.syncChanged, ["AGENTS.md"]);
  assert.ok(
    (await readFile(path.join(legacy, "AGENTS.md"), "utf8")).startsWith(
      "# Team instructions\n\nRead docs/architecture.md before changing normalization.",
    ),
  );
  assert.equal(await readFile(started.recordPath, "utf8"), recordBefore);
  assert.equal(nox(current.cli, legacy, ["sync", "--dry-run"]).value.summary.managedChanges, 0);
  const runs = path.join(legacy, ".git/noxroot/runs");
  await chmod(runs, 0o555);
  try {
    nox(current.cli, legacy, ["status"]);
    for (const args of [["start", task], ["finish"]]) {
      const denied = nox(current.cli, legacy, args, 3);
      assert.equal(denied.value.error, "task-state-unavailable");
      assert.match(denied.value.message, /request write access/);
    }
    assert.equal(await readFile(started.recordPath, "utf8"), recordBefore);
    assert.deepEqual(await snapshot(legacy), synced);
  } finally {
    await chmod(runs, 0o755);
  }
  row.blockedAccess = "status readable; start/finish exit 3; records unchanged; no second store";
  const resumed = nox(current.cli, legacy, ["start", task]).value;
  assert.equal(resumed.record.id, started.record.id);
  assert.equal(resumed.continued, true);
  const originalTest = await readFile(path.join(legacy, "test/value.cjs"), "utf8");
  const result = await cycle(
    current.cli,
    legacy,
    task,
    "test/value.cjs",
    originalTest + 'assert.equal(require("../src/value.cjs").normalize(" a  b "), "a b");\n',
    originalTest + 'assert.equal(require("../src/value.cjs").normalize(" a  b "), "a  b");\n',
    runs,
  );
  Object.assign(row, result, { userDocsPreserved: true, legacyRecordPreserved: true });
  assert.equal((await readdir(path.join(legacy, ".noxroot"))).includes("local"), false);
  row.diff = git(legacy, ["diff"]);
  report.results.push(row);
  await save();
  console.log(
    "Legacy upgrade: same task and baseline; denied access stopped safely; recovery completed.",
  );

  for (const name of ["underscore", "bottle"]) {
    const root = path.join(scratch, name);
    assert.equal(git(root, ["status", "--porcelain"]), "");
    const revision = git(root, ["rev-parse", "HEAD"]);
    const row = { name, revision, setup: await setup(current.cli, root) };
    // Test-only setup stays local; do not create any upstream commit.
    await appendFile(path.join(root, ".git/info/exclude"), "\n/.noxroot/\n/AGENTS.md\n");
    let target, failing, passing, task;
    if (name === "underscore") {
      row.baselineCheck = run(
        "node",
        [
          "-e",
          'require("node:assert/strict").deepEqual(require("./underscore").groupBy([1,2,3], x => x % 2), {0:[2],1:[1,3]})',
        ],
        root,
      );
      row.approvedCommand = await policy(root, "node", ["noxroot-acceptance.cjs"], "test");
      target = "test/noxroot-acceptance.cjs";
      task = "test groupBy preserves input order within groups";
      const prefix =
        'const assert = require("node:assert/strict");\nconst _ = require("../underscore");\nassert.deepEqual(_.groupBy([3, 2, 1], value => value % 2), ';
      failing = prefix + "{0:[2],1:[1,3]});\n";
      passing = prefix + "{0:[2],1:[3,1]});\n";
      row.testScope =
        "Focused native Node assertions against the actual library, not its obsolete full QUnit/lint/browser toolchain.";
    } else {
      row.baselineCheck = run("python3", ["-B", "-m", "unittest", "test.test_router"], root);
      row.approvedCommand = await policy(root, "python3", [
        "-B",
        "-m",
        "unittest",
        "test.test_router",
      ]);
      target = "test/test_router.py";
      task = "test integer router parameters with leading zeros";
      const original = await readFile(path.join(root, target), "utf8");
      const addition =
        '\n    def testAcceptanceLeadingZeroInteger(self):\n        self.assertMatches("/object/<id:int>", "/object/007", id=7)\n';
      passing = original.replace(
        "    def testIntFilter(self):",
        addition + "\n    def testIntFilter(self):",
      );
      assert.notEqual(passing, original);
      failing = passing.replace('"/object/007", id=7)', '"/object/007", id=8)');
      row.testScope =
        "Existing 32 router tests plus one new regression; not the whole web-framework suite.";
    }
    const before = await snapshot(root);
    assert.equal(git(root, ["status", "--porcelain"]), "");
    Object.assign(
      row,
      await cycle(
        current.cli,
        root,
        task,
        target,
        failing,
        passing,
        path.join(root, ".noxroot/local/runs"),
      ),
    );
    const after = await snapshot(root);
    row.changed = Object.keys(after).filter((p) => after[p] !== before[p]);
    assert.deepEqual(row.changed, [target]);
    row.diff = git(root, ["diff"]);
    row.gitStatus = git(root, ["status", "--short"]);
    assert.equal(git(root, ["rev-parse", "HEAD"]), revision);
    git(root, ["diff", "--check"]);
    report.results.push(row);
    await save();
    console.log(
      `${name}: failed check surfaced; same-task continuation; inferred finish completed; no documentation growth.`,
    );
  }
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  await save();
  console.log(`Evidence: ${path.join(scratch, "report.json")}`);
  console.log(report.error ?? "All three workflows passed.");
}
// Keep changed checkouts for inspection. Remove only package/build/cache artifacts
// after validation; never remove dirty worktrees as part of automatic cleanup.
