import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { effectiveAutonomy } from "../src/orchestration/autonomy.js";
import { finishGuidedRun, startGuidedRun } from "../src/orchestration/guided.js";
import { ManualAgentAdapter } from "../src/adapters/agents.js";
import { runProcess } from "../src/adapters/process.js";
import { temporaryDirectory } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(root: string, args: string[]): Promise<void> {
  const result = await runProcess({
    executable: "git",
    args,
    cwd: root,
    repositoryRoot: root,
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

async function repository(): Promise<string> {
  const root = await temporaryDirectory("noxroot-guided-");
  cleanup.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "noxroot-tests@example.invalid"]);
  await git(root, ["config", "user.name", "Noxroot Tests"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "fixture"]);
  return root;
}

const context = {
  task: "change value",
  interpretation: "Change the value implementation.",
  applicableAreas: ["src"],
  likelyOwningSource: ["src/value.ts"],
  selected: [{ path: "src/value.ts", reasons: ["task match"], bytes: 30, estimatedTokens: 8 }],
  likelyTests: [],
  constraints: [],
  requiredVerification: [],
  conflicts: [],
  unknowns: [],
  excluded: [],
  budget: { maximumBytes: 16_000, selectedBytes: 30, estimatedTokens: 8 },
  confidence: "high" as const,
  repositoryFileCount: 1,
  eligibleCandidateFiles: 1,
};

describe("enforced autonomy and guided completion", () => {
  it("caps effective authority and permanently disables merge and delivery", () => {
    const autonomy = effectiveAutonomy({
      autonomy: { default: 5, implementation: 5, review: 5, merge: 3, delivery: 3 },
    } as never);
    expect(autonomy.read).toMatchObject({ effective: 3, authorized: true });
    expect(autonomy.worker).toMatchObject({ effective: 3, authorized: true });
    expect(autonomy.reviewer).toMatchObject({ effective: 3, authorized: true });
    expect(autonomy.merge.authorized).toBe(false);
    expect(autonomy.delivery.authorized).toBe(false);
  });

  it("records a clean baseline, verifies the actual diff, then accepts strict external review", async () => {
    const root = await repository();
    const command = {
      id: "node-check",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: ".",
      timeoutMs: 10_000,
      appliesTo: ["src/**"],
    };
    const record = await startGuidedRun({
      id: "guided-1",
      task: "change value",
      root,
      context,
      effectiveAutonomy: effectiveAutonomy(undefined),
      trustedVerificationPolicy: [command],
    });
    await writeFile(path.join(root, "src", "value.ts"), "export const value = 2;\n");
    await writeFile(path.join(root, "src", "new.ts"), "export const added = true;\n");

    const pending = await finishGuidedRun({
      root,
      record,
      adapter: new ManualAgentAdapter(),
      reviewAuthorized: false,
    });
    expect(pending.status).toBe("review-pending");
    expect(pending.changedPaths).toEqual(["src/new.ts", "src/value.ts"]);
    expect(JSON.stringify(pending.reviewerPackage)).toContain("export const added = true");
    expect(pending.verification.at(-1)?.[0]?.status).toBe("passed");

    const reviewPath = "review.json";
    await writeFile(
      path.join(root, reviewPath),
      JSON.stringify({
        decision: "approved",
        summary: "The bounded change and check evidence are acceptable.",
        findings: [],
        learningCandidates: [],
      }),
    );
    const approved = await finishGuidedRun({
      root,
      record: pending,
      adapter: new ManualAgentAdapter(),
      reviewAuthorized: false,
      reviewFile: reviewPath,
    });
    expect(approved.status).toBe("approved");
    expect(approved.calls.at(-1)?.result.invoked).toBe(false);
    expect(approved.reviewDecision).toBe("approved");
    expect(await readFile(path.join(root, reviewPath), "utf8")).toContain('"approved"');
  });

  it("blocks completion when no approved check matches the actual change", async () => {
    const root = await repository();
    const record = await startGuidedRun({
      id: "guided-2",
      task: "change value",
      root,
      context,
      effectiveAutonomy: effectiveAutonomy(undefined),
      trustedVerificationPolicy: [],
    });
    await writeFile(path.join(root, "src", "value.ts"), "export const value = 3;\n");
    const finished = await finishGuidedRun({
      root,
      record,
      adapter: new ManualAgentAdapter(),
      reviewAuthorized: false,
    });
    expect(finished.status).toBe("blocked");
    expect(finished.verificationGaps).toContain(
      "No approved deterministic checks matched the actual change.",
    );
  });
});
