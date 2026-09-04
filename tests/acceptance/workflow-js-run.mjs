// Three fresh tasks per small JS/TS upstream copy, with inspected native focused checks.
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  environment,
  execute,
  git,
  nox,
  records,
  runAgent,
  save,
  snapshot,
} from "./workflow-support.mjs";

const scratch = process.argv[2];
if (!/^\/tmp\/noxroot-workflows-[\w-]+$/.test(scratch ?? ""))
  throw new Error("Supply a prepared acceptance workspace.");
const state = JSON.parse(await readFile(path.join(scratch, "state.json"), "utf8"));
const cases = JSON.parse(
  await readFile(new URL("./workflow-js-cases.json", import.meta.url), "utf8"),
);
for (const spec of cases) {
  if (process.argv[3] && spec.index !== Number(process.argv[3])) continue;
  const row = structuredClone(state.repositories[spec.index]);
  assert.equal(path.dirname(row.root), scratch);
  const file = path.join(scratch, `js-${spec.index}.json`);
  try {
    const previous = JSON.parse(await readFile(file, "utf8"));
    assert.equal(previous.sessions.length, 0, "Refusing to overwrite agent evidence");
    row.previousAttempt = { error: previous.error, nativeBaseline: previous.nativeBaseline };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  row.tasks = spec.tasks;
  row.expectedTests = spec.expectedTests;
  row.method =
    "Three fresh sandboxed Codex sessions; operator-installed dependencies and approved native focused test command. Local-only maintenance/API-extension tasks, not upstream bug claims or full-suite passes.";
  try {
    environment.npm_config_cache = path.join(row.root, "node_modules/.cache/npm");
    row.install = execute(
      "npm",
      [
        "install",
        "--no-save",
        "--package-lock=false",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        ...(spec.omitDev ? ["--omit=dev"] : []),
        "noxroot@0.1.0",
      ],
      row.root,
    );
    row.nativeBaseline = execute(process.execPath, spec.args, row.root, { allowFailure: true });
    assert.equal(row.nativeBaseline.code, 0, "Native baseline failed");
    row.setup.preview = nox(state, row, ["preview"]);
    row.setup.init = nox(state, row, ["init", "--yes"]);
    assert.equal(row.setup.init.code, 0, "Initialization refused");
    row.setup.uncommittedStart = nox(state, row, ["start", "Assess first-task setup friction"]);
    assert.notEqual(row.setup.uncommittedStart.code, 0);
    row.setup.approvedPolicy = {
      version: 1,
      commands: [
        {
          id: "native-focused-tests",
          executable: "node",
          args: spec.args,
          cwd: ".",
          timeoutMs: 60000,
          appliesTo: ["**/*"],
        },
      ],
    };
    await save(path.join(row.root, ".noxroot/verification.yml"), row.setup.approvedPolicy);
    row.setup.paths = git(row.root, ["status", "--short"]);
    git(row.root, ["add", "--all"]);
    git(row.root, ["commit", "-m", "test: local-only reviewed JS workflow setup"]);
    row.commits.push(git(row.root, ["rev-parse", "HEAD"]));
    await save(file, row);
    for (const [index, task] of spec.tasks.entries()) {
      console.log(`${row.repo} task ${index + 1}/3: fresh Codex session`);
      const before = await snapshot(row.root);
      const session = await runAgent(row, task);
      row.sessions.push(session);
      const after = await snapshot(row.root);
      session.changed = Object.keys({ ...before, ...after }).filter(
        (name) => before[name] !== after[name],
      );
      session.knowledgeChanged = session.changed.filter(
        (name) => name.startsWith(".noxroot/knowledge/") || name.startsWith("docs/"),
      );
      session.diff = git(row.root, ["diff"]);
      session.status = git(row.root, ["status", "--short"]);
      session.policyUnchanged =
        before[".noxroot/verification.yml"] === after[".noxroot/verification.yml"];
      const all = await records(row);
      session.records = all.map((record) => ({
        id: record.id,
        task: record.task,
        status: record.status,
        baseline: record.baseline.revision,
        selected: record.context?.selected?.map((entry) => entry.path),
        learningCandidates: record.learningCandidates,
      }));
      session.nativeFinal = execute(process.execPath, spec.args, row.root, { allowFailure: true });
      await save(file, row);
      console.log(
        `${row.repo} task ${index + 1}: agent=${session.exitCode}, native=${session.nativeFinal.code}, records=${session.records.map((record) => record.status).join(",")}`,
      );
      assert.equal(session.exitCode, 0, "Agent failed or timed out");
      assert.equal(session.policyUnchanged, true, "Agent changed verification policy");
      assert.equal(all.length, index + 1, "Agent did not create one task per new change");
      assert.equal(
        all.filter((record) => record.status === "completed").length,
        index + 1,
        "Agent did not finish the task",
      );
      assert.equal(session.nativeFinal.code, 0, "Native focused check failed");
      assert.ok(
        session.changed.some((name) => spec.expectedTests.includes(name)),
        "Native regression test not changed",
      );
      git(row.root, ["diff", "--check"]);
      git(row.root, ["add", "--all"]);
      git(row.root, ["commit", "-m", `test: local-only JS workflow ${index + 1}`]);
      row.commits.push(git(row.root, ["rev-parse", "HEAD"]));
      await save(file, row);
    }
    row.result = "three-tasks-completed";
  } catch (error) {
    row.result = "blocked";
    row.error = error.message;
  }
  await save(file, row);
  console.log(`${row.repo}: ${row.result}${row.error ? ` (${row.error})` : ""}`);
}
