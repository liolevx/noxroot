// Two matched, single-task controls without Noxroot setup. Exploratory, not a productivity study.
import assert from "node:assert/strict";
import path from "node:path";
import { appendFile, readFile } from "node:fs/promises";
import {
  checkout,
  environment,
  execute,
  git,
  runAgent,
  save,
  snapshot,
} from "./workflow-support.mjs";
const scratch = process.argv[2];
if (!/^\/tmp\/noxroot-workflows-[\w-]+$/.test(scratch ?? ""))
  throw new Error("Supply a prepared acceptance workspace.");
const state = JSON.parse(await readFile(path.join(scratch, "state.json"), "utf8"));
const pythonCases = JSON.parse(
  await readFile(new URL("./workflow-python-cases.json", import.meta.url), "utf8"),
);
const originalPath = environment.PATH;
environment.UV_CACHE_DIR = path.join(scratch, "uv-cache");
for (const index of [0, 4]) {
  const original = state.repositories[index];
  const row = await checkout(state, original, `control-${index}`);
  row.method =
    "One fresh Codex session with no Noxroot setup, matched to the first treatment task on the same upstream revision. Operator installs dependencies and independently runs tests. Not a randomized or repeated productivity experiment.";
  try {
    environment.PATH = originalPath;
    environment.npm_config_cache = path.join(row.root, "node_modules/.cache/npm");
    if (index === 0) {
      execute(
        "npm",
        ["install", "--ignore-scripts", "--package-lock=false", "--no-audit", "--no-fund"],
        row.root,
      );
      row.task = original.tasks[0];
    } else {
      execute("uv", ["venv", ".venv"], row.root);
      execute(
        "uv",
        ["pip", "install", "--python", ".venv/bin/python", "-e", ".", "pytest"],
        row.root,
      );
      await appendFile(
        path.join(row.root, ".gitignore"),
        "\n# Local acceptance prerequisites\n/.venv/\n",
      );
      git(row.root, ["add", "--all"]);
      git(row.root, ["commit", "-m", "test: local-only control environment"]);
      environment.PATH = `${row.root}/.venv/bin:${originalPath}`;
      row.task =
        pythonCases.find((entry) => entry.index === index).tasks[0] +
        "\nTest dependencies are already available in .venv; use .venv/bin/python for Python checks. Do not install anything.";
    }
    assert.equal(git(row.root, ["status", "--porcelain"]), "");
    const before = await snapshot(row.root);
    console.log(`${row.repo}: matched control session, without Noxroot`);
    const session = await runAgent(row, row.task);
    row.sessions.push(session);
    const after = await snapshot(row.root);
    session.changed = Object.keys({ ...before, ...after }).filter(
      (name) => before[name] !== after[name],
    );
    session.diff = git(row.root, ["diff"]);
    session.nativeFinal =
      index === 0
        ? execute("npm", ["test"], row.root, { allowFailure: true })
        : execute(
            path.join(row.root, ".venv/bin/python"),
            ["-m", "pytest", "-q", "tests/test_structures.py"],
            row.root,
            { allowFailure: true },
          );
    session.noxrootInvoked = session.commands.some((item) =>
      /noxroot@|noxroot (?:start|finish|context)/.test(item.command),
    );
    row.result =
      session.exitCode === 0 && session.nativeFinal.code === 0 && !session.noxrootInvoked
        ? "single-control-task-passed"
        : "control-incomplete";
    // A local checkpoint preserves the test diff even when the experiment is incomplete.
    git(row.root, ["add", "--all"]);
    if (git(row.root, ["diff", "--cached", "--name-only"]))
      git(row.root, ["commit", "-m", "test: local-only control evidence checkpoint"]);
    row.commits.push(git(row.root, ["rev-parse", "HEAD"]));
  } catch (error) {
    row.result = "blocked";
    row.error = error.message;
  }
  await save(path.join(scratch, `control-${index}.json`), row);
  console.log(`${row.repo}: ${row.result}`);
}
