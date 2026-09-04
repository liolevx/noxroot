import { execFile } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { identifyChange } from "../src/adapters/vcs.js";
import { applyLearning, proposeLearnings, type LearningProposal } from "../src/knowledge/learn.js";
import type { RunRecord } from "../src/orchestration/run.js";
import { temporaryDirectory } from "./helpers.js";

const roots: string[] = [];
const exec = promisify(execFile);
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function fullCorpus() {
  const root = await temporaryDirectory("noxroot-learning-corpus-");
  roots.push(root);
  await mkdir(path.join(root, ".noxroot/knowledge/archive"), { recursive: true });
  // Oversized and nested documents still consume real corpus space.
  await writeFile(path.join(root, ".noxroot/knowledge/archive/existing.md"), "x".repeat(1_000_000));
  return root;
}

async function approvedCurrentChange<T extends RunRecord>(root: string, run: T) {
  await exec("git", ["init"], { cwd: root });
  await exec("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Fixture"], { cwd: root });
  await writeFile(path.join(root, ".learning-evidence"), "baseline\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-m", "learning baseline"], { cwd: root });
  const revision = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await writeFile(path.join(root, ".learning-evidence"), "validated change\n");
  const changedPaths = [".learning-evidence"];
  return {
    ...run,
    mode: "guided" as const,
    baseline: { revision, status: "" },
    changedPaths,
    changeIdentity: await identifyChange(root, revision, changedPaths),
  };
}

const proposal: LearningProposal = {
  id: "knowledge-corpus",
  signature: "corpus-bound",
  destination: ".noxroot/knowledge/new.md",
  kind: "knowledge",
  evidence: ["regression test"],
  expectedFutureValue: "Preserve a validated boundary.",
  duplication: "not-found",
  conflict: "none",
  content: "A validated repository convention.",
  executableDestination: "The regression test enforces the behavior.",
};

describe("durable knowledge corpus bounds", () => {
  it("links a nested learning destination relative to the knowledge index", async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await applyLearning(root, {
      ...proposal,
      destination: ".noxroot/knowledge/decisions/cache.md",
    });
    expect(await readFile(path.join(root, ".noxroot/knowledge/INDEX.md"), "utf8")).toContain(
      "](decisions/cache.md)",
    );
  });

  it("refuses writes through a knowledge-directory symlink", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    roots.push(root, outside);
    await mkdir(path.join(root, ".noxroot"));
    await symlink(outside, path.join(root, ".noxroot/knowledge"), "junction");
    await expect(applyLearning(root, proposal)).rejects.toThrow(/symbolic link/);
    await expect(readFile(path.join(outside, "new.md"))).rejects.toThrow();
  });

  it("bounds index growth independently of a small learning entry", async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await mkdir(path.join(root, ".noxroot/knowledge"), { recursive: true });
    await writeFile(path.join(root, ".noxroot/knowledge/INDEX.md"), "x".repeat(24_000));
    await expect(applyLearning(root, proposal)).rejects.toThrow(/index would exceed/);
    await expect(readFile(path.join(root, proposal.destination))).rejects.toThrow();
  });

  it("refuses a new-file proposal when nested existing knowledge fills the corpus", async () => {
    const root = await fullCorpus();
    const run: RunRecord & { learningCandidates: unknown[] } = {
      id: "task-corpus",
      task: "bounded task",
      status: "approved",
      calls: [],
      verification: [],
      verificationGaps: [],
      handoff: "",
      learningCandidates: [
        {
          ...proposal,
          expectedValue: proposal.expectedFutureValue,
          whyNotExecutable: proposal.executableDestination,
        },
      ],
    };
    const result = await proposeLearnings(root, await approvedCurrentChange(root, run));
    expect(result.proposals).toEqual([]);
    expect(result.rejected[0]?.reason).toContain("corpus");
  });

  it("rechecks total growth at apply without creating a target or changing the index", async () => {
    const root = await fullCorpus();
    const index = path.join(root, ".noxroot/knowledge/INDEX.md");
    await writeFile(index, "# Existing index\n");
    await expect(applyLearning(root, proposal)).rejects.toThrow(/corpus/);
    expect(await readFile(index, "utf8")).toBe("# Existing index\n");
    await expect(readFile(path.join(root, proposal.destination))).rejects.toThrow();
  });

  it("counts the generated index link in the total write budget", async () => {
    const root = await fullCorpus();
    const targetBytes = Buffer.byteLength(`# Validated learnings\n\n${proposal.content}\n`);
    await writeFile(
      path.join(root, ".noxroot/knowledge/archive/existing.md"),
      "x".repeat(1_000_000 - targetBytes),
    );
    await expect(applyLearning(root, proposal)).rejects.toThrow(/corpus/);
  });

  it("does not let a direct apply call bypass the owned Markdown destination", async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await writeFile(path.join(root, "README.md"), "# Preserve me\n");
    await expect(applyLearning(root, { ...proposal, destination: "README.md" })).rejects.toThrow(
      /owned/,
    );
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("# Preserve me\n");
  });

  it("rejects alternate spellings of the managed index as a learning destination", async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    for (const destination of [
      ".noxroot/knowledge/./INDEX.md",
      ".noxroot/knowledge/index.md",
      ".noxroot\\knowledge\\INDEX.md",
    ]) {
      await expect(applyLearning(root, { ...proposal, destination })).rejects.toThrow(/owned/);
    }
  });
});
