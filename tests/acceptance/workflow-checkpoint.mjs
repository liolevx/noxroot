// Checkpoint only the exact exported experiment; never absorb unrelated staged work.
import assert from "node:assert/strict";
import { git } from "./workflow-support.mjs";

export function checkpointExperiment(root, expectedDiff) {
  assert.equal(git(root, ["diff", "--cached", "--name-only"]), "", "Preserving staged changes");
  const status = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  assert.ok(
    !status.split("\n").some((line) => line.startsWith("??")),
    "Preserving untracked files",
  );
  assert.deepEqual(git(root, ["diff", "--name-only"]).split("\n"), [
    "tests/test_datastructures.py",
  ]);
  assert.ok(expectedDiff, "Missing exported experimental diff");
  assert.equal(
    git(root, ["diff", "--no-ext-diff", "--binary"]),
    expectedDiff.trim(),
    "Experimental diff changed since export",
  );
  git(root, ["add", "--", "tests/test_datastructures.py"]);
  assert.equal(
    git(root, ["diff", "--cached", "--no-ext-diff", "--binary"]),
    expectedDiff.trim(),
    "Staged diff differs from exported evidence",
  );
  git(root, ["commit", "-m", "test: preserve operator-assisted Starlette evidence"]);
  return git(root, ["rev-parse", "HEAD"]);
}
