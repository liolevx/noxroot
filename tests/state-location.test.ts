import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  assertTaskStateWritable,
  enforceRunRetention,
  listRunRecords,
  localStateRoot,
  readRunRecord,
  replaceRunRecord,
  writeRunRecord,
} from "../src/state/local.js";
import { scanRepository } from "../src/detection/scan.js";
import { temporaryDirectory } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function repository() {
  const root = await temporaryDirectory("noxroot-state-location-");
  cleanup.push(root);
  await mkdir(path.join(root, ".git"));
  return root;
}

it("selects workspace-local state without writing during inspection", async () => {
  const root = await repository();
  expect(await localStateRoot(root)).toBe(path.join(root, ".noxroot", "local"));
  expect(await readdir(root)).toEqual([".git"]);
  await writeRunRecord(root, "one", { status: "running" });
  await replaceRunRecord(root, "one", { status: "completed" });
  expect(await readRunRecord(root, "one")).toEqual({ status: "completed" });
  expect(await readFile(path.join(root, ".noxroot/local/.gitignore"), "utf8")).toBe("*\n");
  expect(await readdir(path.join(root, ".git"))).toEqual([]);
  const profile = await scanRepository(root);
  expect(profile.files.some((file) => file.startsWith(".noxroot/local/"))).toBe(false);
});

it("preserves legacy storage and refuses a second store", async () => {
  const root = await repository();
  const legacy = path.join(root, ".git/noxroot");
  await mkdir(legacy);
  await writeRunRecord(root, "existing", { status: "running" });
  expect(await localStateRoot(root)).toBe(legacy);
  await mkdir(path.join(root, ".noxroot/local"), { recursive: true });
  await expect(localStateRoot(root)).rejects.toThrow("Two task-state directories");
  expect(await readFile(path.join(legacy, "runs/existing.json"), "utf8")).toContain("running");
});

it("rejects linked local state without modifying the target", async () => {
  const root = await repository();
  const outside = await temporaryDirectory("noxroot-state-outside-");
  cleanup.push(outside);
  await mkdir(path.join(root, ".noxroot"));
  await symlink(
    outside,
    path.join(root, ".noxroot/local"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(writeRunRecord(root, "one", {})).rejects.toThrow(/symbolic link/);
  expect(await readdir(outside)).toEqual([]);
});

it("refuses linked run directories before inspection or retention", async () => {
  const root = await repository();
  const outside = await temporaryDirectory("noxroot-state-retention-outside-");
  cleanup.push(outside);
  await mkdir(path.join(root, ".noxroot/local"), { recursive: true });
  await writeFile(
    path.join(outside, "old.json"),
    '{"id":"old","status":"completed","finishedAt":"2000-01-01"}\n',
  );
  await symlink(
    outside,
    path.join(root, ".noxroot/local/runs"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(listRunRecords(root)).rejects.toThrow("symbolic link");
  await expect(enforceRunRetention(root, { evidenceDays: 1, maximumRuns: 1 })).rejects.toThrow(
    "symbolic link",
  );
  expect(await readdir(outside)).toEqual(["old.json"]);
});

it("does not overwrite an existing local ignore policy", async () => {
  const root = await repository();
  await mkdir(path.join(root, ".noxroot/local"), { recursive: true });
  await writeFile(path.join(root, ".noxroot/local/.gitignore"), "!runs/\n");
  await expect(writeRunRecord(root, "one", {})).rejects.toThrow(/ignore/);
  expect(await readFile(path.join(root, ".noxroot/local/.gitignore"), "utf8")).toBe("!runs/\n");
});

it("isolates new worktree state but still discovers shared legacy records", async () => {
  const root = await repository();
  const worktree = await temporaryDirectory("noxroot-state-worktree-");
  cleanup.push(worktree);
  const metadata = path.join(root, ".git/worktrees/second");
  await mkdir(metadata, { recursive: true });
  await writeFile(path.join(metadata, "commondir"), "../..\n");
  await writeFile(path.join(worktree, ".git"), `gitdir: ${metadata}\n`);
  expect(await localStateRoot(worktree)).toBe(path.join(worktree, ".noxroot/local"));
  await mkdir(path.join(root, ".git/noxroot"));
  await writeRunRecord(root, "existing", { status: "running" });
  expect(await readRunRecord(worktree, "existing")).toEqual({ status: "running" });
});

it.skipIf(process.platform === "win32")(
  "keeps Git metadata read-only throughout a new lifecycle",
  async () => {
    const root = await repository();
    await chmod(path.join(root, ".git"), 0o555);
    try {
      await writeRunRecord(root, "one", { status: "running" });
      await assertTaskStateWritable(root);
      await replaceRunRecord(root, "one", { status: "completed" });
      expect(await readdir(path.join(root, ".git"))).toEqual([]);
    } finally {
      await chmod(path.join(root, ".git"), 0o755);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "reports blocked legacy storage without creating a fallback",
  async () => {
    const root = await repository();
    const legacy = path.join(root, ".git/noxroot");
    await mkdir(legacy);
    await chmod(legacy, 0o555);
    try {
      await expect(writeRunRecord(root, "one", {})).rejects.toThrow("request write access");
      await expect(assertTaskStateWritable(root)).rejects.toThrow(
        "Do not edit after a failed start",
      );
      expect(await readdir(root)).toEqual([".git"]);
    } finally {
      await chmod(legacy, 0o755);
    }
  },
);
