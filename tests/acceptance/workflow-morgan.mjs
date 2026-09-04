// Three real Codex tasks against a pinned upstream copy; operator owns setup and local commits.
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
  throw new Error("Supply the prepared acceptance workspace.");
const stateFile = path.join(scratch, "state.json");
const state = JSON.parse(await readFile(stateFile, "utf8"));
const row = state.repositories.find((entry) => entry.repo === "expressjs/morgan");
assert.equal(path.dirname(row.root), scratch);
assert.equal(row.sessions.length, 0, "Do not replay tasks into a previously tested copy.");
environment.npm_config_cache = path.join(row.root, "node_modules/.cache/npm");
row.method =
  "Three fresh Codex sessions; one operator-approved focused native Mocha command; full upstream npm test additionally executed by the operator. Disposable extension, not a reported upstream defect.";
const tasks = [
  "Add a :request-id logging token that reads the incoming x-request-id header. A missing header should render the normal missing-token dash through Morgan's existing formatter. Add focused tests in the existing test/morgan.js token tests, first demonstrate the new behavior fails, then implement it. Document the token briefly in README.md. Keep changes small and reuse the existing token escaping and test helpers.",
  "Extend the existing :request-id token to prefer req.id over the request header when req.id is a string or number, including numeric zero. If req.id is null or undefined, keep the existing header fallback. Add tests that fail first, implement the change, and update the existing token documentation without adding a new document.",
  "Extend :request-id to accept an optional header name as :request-id[header-name]. Header names must be case-insensitive, the default remains x-request-id, and req.id still takes precedence. Add regression tests first, then implement the smallest change and amend the existing documentation. Preserve behavior covered in the previous tasks.",
];
row.tasks = tasks;
row.expectedSource = ["index.js"];
row.expectedTests = ["test/morgan.js"];
try {
  // Install scripts are disabled; target package manifests were inspected by the operator.
  row.install = execute(
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
  row.baselineAttempts ??= row.nativeBaseline ? [row.nativeBaseline] : [];
  row.nativeBaseline = execute("npm", ["test"], row.root, { allowFailure: true });
  row.baselineAttempts.push(row.nativeBaseline);
  assert.equal(row.nativeBaseline.code, 0, "Baseline upstream suite failed");
  row.setup.preview = nox(state, row, ["preview"]);
  assert.equal(row.setup.preview.value.initializationAllowed, true);
  row.setup.init = nox(state, row, ["init", "--yes"]);
  assert.equal(row.setup.init.code, 0);
  row.setup.uncommittedStart = nox(state, row, ["start", "Assess first-task setup friction"]);
  assert.notEqual(row.setup.uncommittedStart.code, 0, "Expected real clean-baseline gate");
  const policy = {
    version: 1,
    commands: [
      {
        id: "request-id-tests",
        executable: "node",
        args: [
          "node_modules/mocha/bin/mocha.js",
          "--check-leaks",
          "--grep",
          "request-id",
          "test/morgan.js",
        ],
        cwd: ".",
        timeoutMs: 30000,
        appliesTo: ["**/*"],
      },
    ],
  };
  await save(path.join(row.root, ".noxroot/verification.yml"), policy);
  row.setup.approvedPolicy = policy;
  row.setup.paths = git(row.root, ["status", "--short"]);
  git(row.root, ["add", "--all"]);
  git(row.root, ["commit", "-m", "test: local-only reviewed Noxroot setup"]);
  row.commits.push(git(row.root, ["rev-parse", "HEAD"]));
  row.setup.snapshot = await snapshot(row.root);
  await save(stateFile, state);
  for (const [index, task] of tasks.entries()) {
    console.log(`Morgan task ${index + 1}/3: fresh Codex session`);
    const before = await snapshot(row.root);
    const start = Date.now();
    const session = await runAgent(row, task);
    session.ms = Date.now() - start;
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
    const allRecords = await records(row);
    session.records = allRecords.map((record) => ({
      id: record.id,
      task: record.task,
      status: record.status,
      baseline: record.baseline.revision,
      selected: record.context?.selected?.map((file) => file.path),
      verification: record.verification,
      learningCandidates: record.learningCandidates,
    }));
    session.nativeFinal = execute("npm", ["test"], row.root, { allowFailure: true });
    session.policyUnchanged =
      before[".noxroot/verification.yml"] === after[".noxroot/verification.yml"];
    await save(stateFile, state);
    console.log(
      `Morgan task ${index + 1}: agent=${session.exitCode}, native=${session.nativeFinal.code}, records=${session.records.map((record) => record.status).join(",")}`,
    );
    assert.equal(session.exitCode, 0, "Agent failed or timed out");
    assert.equal(session.policyUnchanged, true, "Agent changed verification policy");
    assert.equal(allRecords.length, index + 1, "Agent did not create one task per new change");
    assert.equal(
      allRecords.filter((record) => record.status === "completed").length,
      index + 1,
      "Agent did not finish the task successfully",
    );
    assert.equal(session.nativeFinal.code, 0, "Upstream suite regressed");
    assert.ok(
      session.changed.includes("index.js") && session.changed.includes("test/morgan.js"),
      "Missing requested source or regression change",
    );
    git(row.root, ["diff", "--check"]);
    git(row.root, ["add", "--all"]);
    git(row.root, ["commit", "-m", `test: local-only request-id workflow ${index + 1}`]);
    row.commits.push(git(row.root, ["rev-parse", "HEAD"]));
    await save(stateFile, state);
  }
  row.result = "three-tasks-completed";
  delete row.error;
} catch (error) {
  row.result = "blocked";
  row.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await save(stateFile, state);
  console.log(`Evidence: ${stateFile}`);
}
