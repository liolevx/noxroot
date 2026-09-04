// Run explicitly with node --test; this fixture never executes external repository scripts.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { git } from "./workflow-support.mjs";
import { checkpointExperiment } from "./workflow-checkpoint.mjs";

for (const scenario of ["expected", "staged", "changed", "untracked"]) {
  test(`checkpoint preserves boundaries: ${scenario}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "noxroot-checkpoint-test-"));
    try {
      git(root, ["init"]);
      git(root, ["config", "user.name", "Acceptance test"]);
      git(root, ["config", "user.email", "acceptance@example.invalid"]);
      await mkdir(path.join(root, "tests"));
      const target = path.join(root, "tests/test_datastructures.py");
      await writeFile(target, "baseline\n");
      await writeFile(path.join(root, "other.txt"), "original\n");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "fixture baseline"]);
      const before = git(root, ["rev-parse", "HEAD"]);
      await writeFile(target, "baseline\nregression\n");
      const exported = git(root, ["diff", "--no-ext-diff", "--binary"]);
      if (scenario === "staged") {
        await writeFile(path.join(root, "other.txt"), "unrelated staged work\n");
        git(root, ["add", "other.txt"]);
      } else if (scenario === "changed") await writeFile(target, "unexpected replacement\n");
      else if (scenario === "untracked") await writeFile(path.join(root, "new.txt"), "keep me\n");
      if (scenario === "expected") {
        assert.notEqual(checkpointExperiment(root, exported), before);
        assert.equal(git(root, ["status", "--porcelain"]), "");
      } else {
        const status = git(root, ["status", "--porcelain"]);
        assert.throws(() => checkpointExperiment(root, exported));
        assert.equal(git(root, ["rev-parse", "HEAD"]), before);
        assert.equal(git(root, ["status", "--porcelain"]), status);
        if (scenario === "staged")
          assert.equal(
            await readFile(path.join(root, "other.txt"), "utf8"),
            "unrelated staged work\n",
          );
      }
    } finally {
      // Only this test's freshly created synthetic fixture is disposable.
      await rm(root, { recursive: true, force: true });
    }
  });
}
