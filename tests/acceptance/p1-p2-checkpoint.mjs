import assert from "node:assert/strict";
import { git } from "./workflow-support.mjs";

export function checkpoint(root, before, expectedDiff, label) {
  assert.equal(git(root, ["rev-parse", "HEAD"]), before, "Agent changed HEAD");
  assert.equal(git(root, ["diff", "--cached", "--name-only"]), "", "Preserving staged changes");
  assert.ok(
    !git(root, ["status", "--porcelain", "--untracked-files=all"])
      .split("\n")
      .some((line) => line.startsWith("??")),
    "Preserving untracked files",
  );
  const changed = git(root, ["diff", "--name-only"]).split("\n");
  assert.ok(changed.every((f) => f.startsWith("src/") || f.startsWith("tests/")));
  assert.ok(expectedDiff, "Missing exported diff");
  assert.equal(git(root, ["diff", "--no-ext-diff", "--binary"]), expectedDiff);
  git(root, ["add", "--", ...changed]);
  assert.equal(git(root, ["diff", "--cached", "--no-ext-diff", "--binary"]), expectedDiff);
  git(root, ["commit", "-m", `fixture ${label} retry summary`]);
}
