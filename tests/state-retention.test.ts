import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  enforceRunRetention,
  listRunRecords,
  localStateRoot,
  writeRunRecord,
} from "../src/state/local.js";
import { temporaryDirectory } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await temporaryDirectory("noxroot-retention-");
  cleanup.push(root);
  await mkdir(path.join(root, ".git"));
  return root;
}

describe("local run retention", () => {
  it("bounds 600 synthetic sessions without removing unfinished work", async () => {
    const root = await repository();
    const now = Date.parse("2026-09-03T12:00:00.000Z");
    for (let index = 0; index < 600; index += 1) {
      const id = `run-${index.toString().padStart(3, "0")}`;
      const protectedStatus = index === 0 ? "running" : index === 1 ? "incomplete" : "completed";
      await writeRunRecord(root, id, {
        id,
        status: protectedStatus,
        startedAt: new Date(now - index * 1_000).toISOString(),
        ...(protectedStatus === "completed"
          ? { finishedAt: new Date(now - index * 1_000).toISOString() }
          : {}),
      });
    }

    const result = await enforceRunRetention(
      root,
      { evidenceDays: 30, maximumRuns: 100 },
      now,
    );

    expect(result).toMatchObject({ retained: 100, protected: 2 });
    expect(result.removed).toHaveLength(500);
    const records = await listRunRecords<{ id: string }>(root);
    expect(records.map((record) => record.id)).toEqual(
      expect.arrayContaining(["run-000", "run-001"]),
    );
  });

  it("expires old completed evidence but preserves old incomplete and malformed records", async () => {
    const root = await repository();
    const now = Date.parse("2026-09-03T12:00:00.000Z");
    const old = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    await writeRunRecord(root, "old-completed", {
      id: "old-completed",
      status: "completed",
      startedAt: old,
      finishedAt: old,
    });
    await writeRunRecord(root, "old-incomplete", {
      id: "old-incomplete",
      status: "incomplete",
      startedAt: old,
    });
    await writeRunRecord(root, "recent-completed", {
      id: "recent-completed",
      status: "completed",
      startedAt: recent,
      finishedAt: recent,
    });
    const runs = path.join(await localStateRoot(root), "runs");
    await writeFile(path.join(runs, "malformed.json"), "not json\n");

    const result = await enforceRunRetention(
      root,
      { evidenceDays: 30, maximumRuns: 100 },
      now,
    );

    expect(result).toEqual({ removed: ["old-completed"], retained: 3, protected: 2 });
    expect(await readFile(path.join(runs, "old-incomplete.json"), "utf8")).toContain(
      '"incomplete"',
    );
    expect(await readFile(path.join(runs, "malformed.json"), "utf8")).toBe("not json\n");
  });
});
