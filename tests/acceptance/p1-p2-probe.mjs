// Opt-in pinned read-only regression probe. No upstream scripts or dependencies are executed.
import assert from "node:assert/strict";
import { mkdtemp, readFile, lstat, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { git, checkout, save, execute } from "./workflow-support.mjs";
const [mode, supplied] = process.argv.slice(2);
const names = [
  "sveltejs/kit",
  "jqlang/jq",
  "jedisct1/libsodium",
  "withastro/astro",
  "pytest-dev/pluggy",
];
if (mode === "prepare") {
  const root = await mkdtemp("/tmp/noxroot-p1-p2-");
  const state = { root, repositories: [] };
  await save(path.join(root, "state.json"), state);
  const evidence = (
    await Promise.all(
      ["adoption-results-2026-09-04.json", "results-2026-09-03-final.json"].map(async (file) =>
        JSON.parse(await readFile(new URL(file, import.meta.url), "utf8")),
      ),
    )
  ).flatMap((r) => r.results);
  for (const [i, name] of names.entries()) {
    const spec = evidence.find((r) => r.repo === name);
    assert.ok(spec);
    state.repositories.push(
      await checkout(state, { repo: name, revision: spec.revision, task: spec.task }, i),
    );
    await save(path.join(root, "state.json"), state);
  }
  console.log(root);
} else {
  assert.match(supplied ?? "", /^\/tmp\/noxroot-p1-p2-[\w-]+$/);
  assert.ok(!(await lstat(supplied)).isSymbolicLink());
  const state = JSON.parse(await readFile(path.join(supplied, "state.json"), "utf8"));
  assert.equal(state.root, supplied);
  for (const row of state.repositories) {
    assert.equal(path.dirname(row.root), supplied);
    assert.ok(!(await lstat(row.root)).isSymbolicLink());
    assert.equal(git(row.root, ["status", "--porcelain", "--untracked-files=all"]), "");
  }
  if (mode === "cleanup") {
    for (const row of state.repositories) await rm(row.root, { recursive: true });
    await rm(path.join(supplied, "state.json"));
    // rmdir, not recursive deletion: preserve any unexpected scratch files.
    await rmdir(supplied);
    console.log("Removed pinned probe copies and state.");
  } else {
    assert.equal(mode, "probe");
    const results = [];
    for (const row of state.repositories) {
      const run = (args) =>
        JSON.parse(
          execute(
            process.execPath,
            [path.resolve("dist/cli.js"), ...args, "--root", row.root, "--json"],
            process.cwd(),
          ).stdout,
        );
      const context = run(["context", row.task]);
      const preview = run(["preview"]);
      results.push({
        repo: row.repo,
        revision: row.revision,
        task: row.task,
        selected: context.selected,
        owners: context.likelyOwningSource,
        budget: context.budget,
        unknowns: context.unknowns,
        conflicts: preview.conflicts,
        allowed: preview.initializationAllowed,
        evidence: preview.profile?.evidence?.filter((e) => e.status === "conflicting"),
        capabilities: preview.capabilities,
      });
      assert.equal(git(row.root, ["status", "--porcelain", "--untracked-files=all"]), "");
    }
    await save(process.argv[4], results);
    console.log(
      JSON.stringify(
        results.map((r) => ({
          repo: r.repo,
          owners: r.owners,
          conflicts: r.conflicts,
          unknowns: r.unknowns,
        })),
        null,
        2,
      ),
    );
  }
}
