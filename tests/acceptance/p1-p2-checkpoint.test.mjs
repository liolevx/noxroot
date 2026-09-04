import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { git } from "./workflow-support.mjs";
import { checkpoint } from "./p1-p2-checkpoint.mjs";

for (const scenario of ["expected", "staged", "head", "changed", "untracked"]) {
  test(`agent checkpoint: ${scenario}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "noxroot-p1-p2-checkpoint-"));
    try {
      git(root, ["init"]);
      git(root, ["config", "user.name", "Acceptance test"]);
      git(root, ["config", "user.email", "acceptance@example.invalid"]);
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "src/retry.js"), "baseline\n");
      await writeFile(path.join(root, "policy.txt"), "original\n");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "fixture"]);
      const before = git(root, ["rev-parse", "HEAD"]);
      await writeFile(path.join(root, "src/retry.js"), "updated\n");
      const diff = git(root, ["diff", "--no-ext-diff", "--binary"]);
      if (scenario === "staged") {
        await writeFile(path.join(root, "policy.txt"), "unexpected staged policy\n");
        git(root, ["add", "policy.txt"]);
      } else if (scenario === "head")
        git(root, ["commit", "--allow-empty", "-m", "unexpected commit"]);
      else if (scenario === "changed")
        await writeFile(path.join(root, "src/retry.js"), "later change\n");
      else if (scenario === "untracked")
        await writeFile(path.join(root, "other.txt"), "preserve\n");
      const status = git(root, ["status", "--porcelain"]);
      const head = git(root, ["rev-parse", "HEAD"]);
      if (scenario === "expected") {
        checkpoint(root, before, diff, scenario);
        assert.equal(git(root, ["status", "--porcelain"]), "");
      } else {
        assert.throws(() => checkpoint(root, before, diff, scenario));
        assert.equal(git(root, ["status", "--porcelain"]), status);
        assert.equal(git(root, ["rev-parse", "HEAD"]), head);
      }
    } finally {
      // Only this test's newly created synthetic fixture is disposable.
      await rm(root, { recursive: true, force: true });
    }
  });
}
