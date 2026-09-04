// Export bounded, reproducible evidence. Optional cleanup only removes verified owned copies.
import assert from "node:assert/strict";
import path from "node:path";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { git, records, removeCleanCopy, save } from "./workflow-support.mjs";
import { checkpointExperiment } from "./workflow-checkpoint.mjs";
const [scratch, destination, cleanup] = process.argv.slice(2);
if (!/^\/tmp\/noxroot-workflows-[\w-]+$/.test(scratch ?? "") || !destination)
  throw new Error("Supply SCRATCH OUTPUT.json [--cleanup].");
const state = JSON.parse(await readFile(path.join(scratch, "state.json"), "utf8"));
assert.equal(state.root, scratch);
const rows = [];
for (const [index, original] of state.repositories.entries()) {
  let row = original;
  for (const name of [`python-${index}.json`, `js-${index}.json`, `monorepo-${index}.json`]) {
    try {
      row = JSON.parse(await readFile(path.join(scratch, name), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  rows.push(row);
}
for (const index of [0, 4])
  rows.push(JSON.parse(await readFile(path.join(scratch, `control-${index}.json`), "utf8")));
const bounded = (result) =>
  result && {
    code: result.code,
    stdout: result.stdout?.slice(-3500),
    stderr: result.stderr?.slice(-1500),
  };
const summarizeRecord = (record) => ({
  id: record.id,
  task: record.task,
  status: record.status,
  baseline: record.baseline?.revision,
  selected: record.context?.selected?.map((entry) => entry.path),
  verification: record.verification?.map((attempt) =>
    attempt.map((check) => ({
      id: check.command.id,
      status: check.status,
      durationMs: check.evidence.durationMs,
      timedOut: check.evidence.timedOut,
      exitCode: check.evidence.exitCode,
      output: check.evidence.stdout.slice(-1200),
    })),
  ),
  verificationGaps: record.verificationGaps,
  learningCandidates: record.learningCandidates,
});
const report = {
  package: "noxroot@0.1.0",
  integrity: state.integrity,
  method:
    "Ten pinned repository adoption attempts, with three fresh Codex tasks per executable case and two single-task controls. Operator-managed dependencies, reviewed focused policies and local commits. No upstream contributions or publication. This is not ten full-suite passes, an adoption study, or a productivity benchmark.",
  agentInvocation: [
    "codex",
    "-a",
    "never",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "workspace-write",
    "--json",
    "-C",
    "<disposable-root>",
  ],
  exportedAt: new Date().toISOString(),
  results: [],
  cleanup: { scratch, removed: false, retained: [] },
};
for (const row of rows) {
  assert.equal(path.dirname(path.resolve(row.root)), scratch);
  const allRecords = await records(row);
  report.results.push({
    repo: row.repo,
    revision: row.revision,
    root: row.root,
    method: row.method,
    result: row.result,
    error: row.error,
    tasks: row.tasks ?? [row.task],
    expectedSource: row.expectedSource,
    expectedTests: row.expectedTests,
    commits: row.commits,
    nativeBaseline: bounded(row.nativeBaseline),
    baselineAttempts: row.baselineAttempts?.map(bounded),
    previousAttempt: row.previousAttempt && {
      error: row.previousAttempt.error,
      nativeBaseline: bounded(row.previousAttempt.nativeBaseline),
    },
    install: bounded(row.install),
    minimumReleaseAge: row.minimumReleaseAge,
    packageManager: row.packageManager,
    setup: row.setup && {
      paths: row.setup.paths,
      uncommittedStart: bounded(row.setup.uncommittedStart),
      approvedPolicy: row.setup.approvedPolicy,
    },
    sessions: row.sessions.map((session) => ({
      startedAt: session.startedAt,
      finishedAt: session.finishedAt,
      exitCode: session.exitCode,
      changed: session.changed,
      knowledgeChanged: session.knowledgeChanged,
      policyUnchanged: session.policyUnchanged,
      commandCount: session.commands.length,
      commands: session.commands
        .filter((item) =>
          /noxroot@|noxroot (?:start|finish|context)|pytest|mocha|node --test|npm (?:run|test)/.test(
            item.command,
          ),
        )
        .map((item) => ({
          command: item.command,
          code: item.code,
          output: item.output?.slice(-3000),
        })),
      summary: session.summary,
      diff: session.diff,
      recordsAtSessionEnd: session.records,
      nativeFinal: bounded(session.nativeFinal),
      noxrootInvoked: session.noxrootInvoked,
    })),
    records: allRecords.map(summarizeRecord),
    operatorDiagnostic: row.operatorDiagnostic,
    status: git(row.root, ["status", "--short"]),
    diff: row.diff,
    exportedWorkingDiff: git(row.root, ["diff", "--no-ext-diff", "--binary"]),
  });
}
await save(destination, report);
if (cleanup === "--cleanup") {
  // Checkpoint only a reviewed, already exported experimental diff. This is evidence, not approval.
  for (const row of rows) {
    const status = git(row.root, ["status", "--porcelain", "--untracked-files=all"]);
    if (status && row.repo === "encode/starlette") {
      const exported = report.results.find((item) => item.root === row.root);
      assert.equal(
        exported.exportedWorkingDiff,
        row.sessions.at(-1)?.diff?.trim(),
        "Preserving changes made after the recorded Starlette experiment",
      );
      exported.cleanupCheckpoint = checkpointExperiment(row.root, exported.exportedWorkingDiff);
    }
    if (git(row.root, ["status", "--porcelain", "--untracked-files=all"]))
      report.cleanup.retained.push(row.root);
  }
  // Never remove a dirty checkout. These exact disposable roots were created by this harness.
  for (const row of rows)
    if (!report.cleanup.retained.includes(row.root)) await removeCleanCopy(state, row);
  if (report.cleanup.retained.length) {
    await save(destination, report);
    throw new Error("Preserved dirty copies and their recovery state; inspect before cleanup.");
  }
  const ownedDirectories = new Set([
    "installed",
    "cache",
    "uv-cache",
    "pnpm-store",
    "manager-8",
    "manager-9",
  ]);
  for (const name of await readdir(scratch)) {
    const target = path.join(scratch, name);
    const info = await lstat(target);
    if (ownedDirectories.has(name) && info.isDirectory() && !info.isSymbolicLink())
      await rm(target, { recursive: true });
    else if (
      (name === "state.json" || /^(?:python|js|monorepo|control)-\d+\.json$/.test(name)) &&
      info.isFile()
    )
      await rm(target);
  }
  if ((await readdir(scratch)).length === 0) {
    await rm(scratch, { recursive: true });
    report.cleanup.removed = true;
  } else report.cleanup.remainingEntries = await readdir(scratch);
  await save(destination, report);
}
console.log(
  JSON.stringify(
    {
      results: report.results.map((row) => ({
        repo: row.repo,
        result: row.result,
        sessions: row.sessions.length,
      })),
      cleanup: report.cleanup,
    },
    null,
    2,
  ),
);
