import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyProposals } from "../src/core/init.js";
import { previewRepository } from "../src/core/preview.js";
import { hashTree, temporaryDirectory } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const parent = await temporaryDirectory("noxroot-init-path-");
  cleanup.push(parent);
  const root = path.join(parent, "repository");
  const outside = path.join(parent, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(root, "package.json"), '{"name":"path-safety"}\n');
  await writeFile(path.join(outside, "keep.txt"), "Unrelated content.\n");
  return { root, outside };
}

describe("initialization destination safety", () => {
  it.each([".noxroot", ".noxroot/knowledge", "AGENTS.md"])(
    "refuses a linked destination at %s without partial setup",
    async (relative) => {
      const { root, outside } = await setup();
      const destination = path.join(root, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await symlink(outside, destination, "junction");
      const before = await hashTree(root);
      const outsideBefore = await hashTree(outside);
      const preview = await previewRepository(root);
      expect(preview.initializationAllowed).toBe(false);
      expect(preview.conflicts.join("\n")).toMatch(/symbolic link/i);
      await expect(applyProposals(preview)).rejects.toThrow();
      // The application boundary must enforce safety even for a caller-supplied preview.
      await expect(applyProposals({ ...preview, initializationAllowed: true })).rejects.toThrow(
        /symbolic link/i,
      );
      expect(await hashTree(root)).toBe(before);
      expect(await hashTree(outside)).toBe(outsideBefore);
    },
  );

  it("rechecks every destination when a link is introduced after preview", async () => {
    const { root, outside } = await setup();
    const preview = await previewRepository(root);
    expect(preview.initializationAllowed).toBe(true);
    await mkdir(path.join(root, ".noxroot"));
    await symlink(outside, path.join(root, ".noxroot/knowledge"), "junction");
    const before = await hashTree(root);
    const outsideBefore = await hashTree(outside);
    await expect(applyProposals(preview)).rejects.toThrow(/symbolic link/i);
    expect(await hashTree(root)).toBe(before);
    expect(await hashTree(outside)).toBe(outsideBefore);
  });

  it("rejects a repository root replaced by a link after preview", async () => {
    const { root, outside } = await setup();
    const preview = await previewRepository(root);
    await rm(root, { recursive: true });
    await symlink(outside, root, "junction");
    const before = await hashTree(outside);
    await expect(applyProposals(preview)).rejects.toThrow(/symbolic link|root changed/i);
    expect(await hashTree(outside)).toBe(before);
  });

  it("does not refuse setup merely because an unrelated link exists", async () => {
    const { root, outside } = await setup();
    await symlink(outside, path.join(root, "unrelated"), "junction");
    const before = await hashTree(outside);
    const preview = await previewRepository(root);
    expect(preview.initializationAllowed).toBe(true);
    expect((await applyProposals(preview)).created).toContain(".noxroot/config.yml");
    expect(await hashTree(outside)).toBe(before);
  });
});
