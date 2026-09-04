// Three successive changes per prepared Python repository. Sessions are fresh and sequential.
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  environment,
  execute,
  git,
  records,
  runAgent,
  save,
  snapshot,
} from "./workflow-support.mjs";

const scratch = process.argv[2];
if (!/^\/tmp\/noxroot-workflows-[\w-]+$/.test(scratch ?? ""))
  throw new Error("Supply a prepared acceptance workspace.");
const cases = JSON.parse(
  await readFile(new URL("./workflow-python-cases.json", import.meta.url), "utf8"),
);
const originalPath = environment.PATH;
for (const spec of cases) {
  const file = path.join(scratch, `python-${spec.index}.json`);
  const row = JSON.parse(await readFile(file, "utf8"));
  assert.equal(path.dirname(row.root), scratch);
  if (row.result !== "prepared") {
    console.log(`${row.repo}: baseline blocked; no agent started`);
    continue;
  }
  row.tasks = spec.tasks;
  row.method =
    "Three fresh Codex sessions on an upstream copy. Operator installed dependencies, selected one native test file, and committed reviewed setup. Tasks 1/3 primarily extend regression coverage; task 2 introduces a local-only API extension. Not an upstream bug claim or full-suite pass.";
  try {
    environment.PATH = `${row.root}/.venv/bin:${originalPath}`;
    environment.npm_config_cache = path.join(row.root, "node_modules/.cache/npm");
    row.runtimeInstall = execute(
      "npm",
      [
        "install",
        "--no-save",
        "--package-lock=false",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "noxroot@0.1.0",
      ],
      row.root,
    );
    assert.equal(
      git(row.root, ["status", "--porcelain"]),
      "",
      "Runtime installation dirtied committed setup",
    );
    for (const [index, task] of spec.tasks.entries()) {
      console.log(`${row.repo} task ${index + 1}/3: fresh Codex session`);
      const before = await snapshot(row.root);
      const session = await runAgent(
        row,
        task +
          "\nTest dependencies are already available in .venv; use .venv/bin/python for Python checks. Do not install anything.",
      );
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
      const command = row.setup.approvedPolicy.commands[0];
      session.nativeFinal = execute(command.executable, command.args, row.root, {
        allowFailure: true,
      });
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
        session.changed.some((name) => row.expectedTests.includes(name)),
        "Expected native regression tests were not changed",
      );
      if (index === 1)
        assert.ok(
          session.changed.some((name) => row.expectedSource.includes(name)),
          "Expected API implementation was not changed",
        );
      git(row.root, ["diff", "--check"]);
      git(row.root, ["add", "--all"]);
      git(row.root, ["commit", "-m", `test: local-only data-structure workflow ${index + 1}`]);
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
