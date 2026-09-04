// Export bounded evidence, then remove only verified, clean disposable fixtures.
import assert from "node:assert/strict";
import { readFile, readdir, realpath, lstat, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { git, save, snapshot } from "./workflow-support.mjs";

const [scratch, output] = process.argv.slice(2);
assert.match(scratch ?? "", /^\/tmp\/noxroot-p1-p2-live-[\w-]+$/);
assert.equal(await realpath(scratch), scratch);
assert.equal((await lstat(scratch)).isSymbolicLink(), false);
const state = JSON.parse(await readFile(path.join(scratch, "state.json"), "utf8"));
assert.equal(state.root, scratch);
assert.equal(state.stage, "completed");
const expected = [
  "application",
  "bin",
  "control",
  "director.tar.gz",
  "hub",
  "runtime",
  "state.json",
].sort();
assert.deepEqual((await readdir(scratch)).sort(), expected);
const context = (value) => ({
  selected: value.selected.map((x) => x.path),
  excluded: value.excluded.filter((x) => x.path?.startsWith(".noxroot/knowledge/")),
  budget: value.budget,
  unknowns: value.unknowns,
});
const checks = (record) =>
  record.verification.flat().map((v) => ({
    command: v.command,
    status: v.status,
    exitCode: v.evidence?.exitCode,
    stdoutTail: v.evidence?.stdout?.slice(-1500),
    stderrTail: v.evidence?.stderr?.slice(-1500),
  }));
const repositories = [];
for (const root of [state.app, state.control]) {
  assert.ok(["application", "control"].includes(path.basename(root)));
  assert.equal(path.dirname(root), scratch);
  assert.equal(await realpath(root), root);
  assert.equal(git(root, ["status", "--porcelain", "--untracked-files=all"]), "");
  assert.equal(git(root, ["remote"]), "");
  repositories.push({
    root,
    head: git(root, ["rev-parse", "HEAD"]),
    tree: await snapshot(root),
    commits: git(root, ["log", "--oneline"]),
    diff: git(root, ["diff", "HEAD~4", "HEAD"]),
  });
}
const evidence = {
  date: new Date().toISOString(),
  scope:
    "Candidate build; synthetic application; real Director binary and two fresh Codex CLI sessions. Not a production deployment or productivity benchmark.",
  directorSource: state.directorSource,
  directorBefore: state.directorBefore,
  directorAfter: state.directorAfter,
  firstTask: state.firstTask,
  firstChecks: checks(state.firstRecord ?? { verification: state.firstChecks }),
  reviewInput:
    "Scripted acceptance review based on existing Director decision and passing tests; not independent model discovery.",
  acceptedLesson: state.acceptedLesson,
  recovery: state.recovery && {
    reason: state.recovery.reason,
    before: context(state.recovery.before),
    commits: state.recovery.commits,
  },
  retrieval: {
    control: context(state.beforeLearning),
    related: context(state.related),
    unrelated: context(state.unrelated),
    duplicateProposals: state.duplicateProposals ?? 0,
  },
  sessions: state.sessions.map(({ record, ...session }) => ({
    ...session,
    task: record?.id,
    status: record?.status,
    checks: record ? checks(record) : [],
    contextPaths: record?.context?.selected?.map((x) => x.path),
  })),
  repositories,
  cleanup: { root: scratch, complete: false },
};
assert.ok(path.resolve(output).startsWith(path.resolve("tests/acceptance") + path.sep));
await save(output, evidence);
for (const row of repositories) {
  assert.equal(git(row.root, ["status", "--porcelain", "--untracked-files=all"]), "");
  assert.equal(git(row.root, ["rev-parse", "HEAD"]), row.head);
  assert.deepEqual(await snapshot(row.root), row.tree);
}
// All final absolute targets are direct, validated children of this exact task scratch root.
for (const name of expected.filter((x) => x !== "state.json"))
  await rm(path.join(scratch, name), { recursive: true, force: false });
await rm(path.join(scratch, "state.json"));
await rmdir(scratch);
evidence.cleanup.complete = true;
await save(output, evidence);
console.log(
  `Evidence saved to ${output}; disposable application, control, Director state and runtime removed.`,
);
