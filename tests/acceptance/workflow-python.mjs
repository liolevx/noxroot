// Opt-in preparation and native baseline for the four Python workflow copies.
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { environment, execute, git, nox, save, snapshot } from "./workflow-support.mjs";

const scratch = process.argv[2];
if (!/^\/tmp\/noxroot-workflows-[\w-]+$/.test(scratch ?? ""))
  throw new Error("Supply a prepared acceptance workspace.");
// Write per-repository files, not shared state: another opt-in workflow may be running.
const state = JSON.parse(await readFile(path.join(scratch, "state.json"), "utf8"));
const cases = [
  {
    repo: "psf/requests",
    test: "tests/test_structures.py",
    extra: ["pytest"],
    source: ["src/requests/structures.py"],
  },
  {
    repo: "encode/httpx",
    test: "tests/models/test_queryparams.py",
    extra: ["pytest", "trustme", "uvicorn", "trio", "pytest-asyncio"],
    source: ["httpx/_urls.py"],
  },
  {
    repo: "encode/starlette",
    test: "tests/test_datastructures.py",
    extra: ["pytest", "httpx", "httpx2", "trio"],
    source: ["starlette/datastructures.py"],
  },
  {
    repo: "pallets/flask",
    test: "tests/test_config.py",
    extra: ["pytest", "python-dotenv"],
    source: ["src/flask/config.py"],
  },
];
environment.UV_CACHE_DIR = path.join(scratch, "uv-cache");
for (const spec of cases) {
  const row = structuredClone(state.repositories.find((entry) => entry.repo === spec.repo));
  const index = state.repositories.findIndex((entry) => entry.repo === spec.repo);
  row.expectedSource = spec.source;
  row.expectedTests = [spec.test];
  assert.equal(path.dirname(row.root), scratch);
  try {
    execute("uv", ["venv", ".venv"], row.root);
    row.install = execute(
      "uv",
      ["pip", "install", "--python", ".venv/bin/python", "-e", ".", ...spec.extra],
      row.root,
    );
    environment.npm_config_cache = path.join(row.root, "node_modules/.cache/npm");
    execute(
      "npm",
      [
        "install",
        "--prefix",
        "node_modules/.noxroot-tools",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "noxroot@0.1.0",
      ],
      row.root,
    );
    // The normal npx command must resolve from a local shim without relying on sandbox network.
    // Record this operator-prepared runtime explicitly; do not modify agent instructions.
    const python = path.join(row.root, ".venv/bin/python");
    row.nativeBaseline = execute(python, ["-m", "pytest", "-q", spec.test], row.root, {
      allowFailure: true,
    });
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
          executable: python,
          args: ["-m", "pytest", "-q", spec.test],
          cwd: ".",
          timeoutMs: 30000,
          appliesTo: ["**/*"],
        },
      ],
    };
    await save(path.join(row.root, ".noxroot/verification.yml"), row.setup.approvedPolicy);
    // A committed local ignore entry for the operator's installed tools is visible setup, not
    // an exclusion that hides Noxroot's generated configuration from the baseline check.
    const { appendFile, mkdir, symlink } = await import("node:fs/promises");
    await appendFile(
      path.join(row.root, ".gitignore"),
      "\n# Local acceptance prerequisites\n/node_modules/\n/.venv/\n",
    );
    await mkdir(path.join(row.root, "node_modules/.bin"), { recursive: true });
    await symlink(
      "../.noxroot-tools/node_modules/noxroot/dist/cli.js",
      path.join(row.root, "node_modules/.bin/noxroot"),
    );
    row.setup.paths = git(row.root, ["status", "--short"]);
    git(row.root, ["add", "--all"]);
    git(row.root, ["commit", "-m", "test: local-only reviewed Python workflow setup"]);
    row.commits.push(git(row.root, ["rev-parse", "HEAD"]));
    row.setup.snapshot = await snapshot(row.root);
    row.result = "prepared";
  } catch (error) {
    row.result = "blocked";
    row.error = error.message;
  }
  await save(path.join(scratch, `python-${index}.json`), row);
  console.log(`${spec.repo}: ${row.result}${row.error ? ` (${row.error})` : ""}`);
}
