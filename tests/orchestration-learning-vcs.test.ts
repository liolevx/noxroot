import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRequest, AgentResult } from "../src/adapters/agents.js";
import { boundedDiff, prepareIsolatedWorktree } from "../src/adapters/vcs.js";
import { applyLearning, proposeLearnings } from "../src/knowledge/learn.js";
import type { ContextPackage, VerificationResult } from "../src/model.js";
import { orchestrateRun, type RunRecord } from "../src/orchestration/run.js";
import { temporaryDirectory } from "./helpers.js";

const exec = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((operation) => operation())));

const context: ContextPackage = {
  task: "change greeting",
  interpretation: "bounded greeting change",
  intent: {
    requiredOutcomes: ["change greeting"],
    explicitExclusions: [],
    requestedAuthority: [],
    acceptanceCriteria: [],
  },
  confidence: "high",
  repositoryFileCount: 2,
  eligibleCandidateFiles: 2,
  applicableAreas: ["src"],
  selected: [],
  likelyOwningSource: ["src/greet.ts"],
  likelyTests: ["tests/greet.test.ts"],
  constraints: [],
  requiredVerification: [],
  conflicts: [],
  unknowns: [],
  excluded: [],
  budget: { maximumBytes: 1000, selectedBytes: 0, estimatedTokens: 0 },
};

function check(status: "passed" | "failed"): VerificationResult {
  return {
    command: {
      id: "test",
      executable: "node",
      args: ["test.js"],
      cwd: ".",
      timeoutMs: 1000,
      appliesTo: ["src/**"],
    },
    evidence: {
      executable: "node",
      args: ["test.js"],
      cwd: ".",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:00.001Z",
      durationMs: 1,
      exitCode: status === "passed" ? 0 : 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      outputTruncated: false,
    },
    status,
  };
}

class FakeAdapter implements AgentAdapter {
  readonly id = "fake";
  readonly mode = "command" as const;
  readonly roles: AgentRequest["role"][] = [];
  private reviews = 0;

  constructor(private readonly requestRepair = false) {}

  async availability() {
    return { available: true, reason: "deterministic fixture" };
  }

  async invoke(request: AgentRequest): Promise<AgentResult> {
    this.roles.push(request.role);
    if (request.role === "reviewer") {
      this.reviews += 1;
      const decision = this.requestRepair && this.reviews === 1 ? "changes-requested" : "approved";
      return {
        invoked: true,
        status: "completed",
        summary: `review ${decision}`,
        output: JSON.stringify({ decision }),
        exitCode: 0,
        reviewDecision: decision,
      };
    }
    return {
      invoked: true,
      status: "completed",
      summary: `${request.role} complete`,
      output: "ok",
      exitCode: 0,
    };
  }
}

describe("orchestration, worktree isolation, and controlled learning", () => {
  it("stops before review with an incomplete, never-approved result when no check matched", async () => {
    const adapter = new FakeAdapter();
    const record = await orchestrateRun(
      {
        id: "task-no-checks",
        task: context.task,
        context,
        cwd: "/repo",
        repositoryRoot: "/repo",
        adapter,
        budgets: { workerCalls: 2, reviewerCalls: 2, repairIterations: 1 },
      },
      { verify: async () => [], diff: async () => "diff" },
    );
    expect(record.status).toBe("incomplete");
    expect(record.reviewDecision).not.toBe("approved");
    expect(adapter.roles).toEqual(["worker"]);
    expect(record.handoff).toContain("No approved deterministic checks matched");
  });

  it("runs worker, deterministic verification, and a separate reviewer", async () => {
    const adapter = new FakeAdapter();
    let verifies = 0;
    const record = await orchestrateRun(
      {
        id: "task-1",
        task: context.task,
        context,
        cwd: "/repo",
        repositoryRoot: "/repo",
        adapter,
        budgets: { workerCalls: 2, reviewerCalls: 2, repairIterations: 1 },
      },
      {
        verify: async () => {
          verifies += 1;
          return [check("passed")];
        },
        diff: async () => "diff --git a/src/auth/session.ts b/src/auth/session.ts",
      },
    );
    expect(adapter.roles).toEqual(["worker", "reviewer"]);
    expect(verifies).toBe(1);
    expect(record.status).toBe("approved");
    expect(record.handoff).toContain("Noxroot did not merge or push it");
  });

  it("completes a routine checked change without an unnecessary reviewer", async () => {
    const adapter = new FakeAdapter();
    const record = await orchestrateRun(
      {
        id: "task-routine",
        task: context.task,
        context,
        cwd: "/repo",
        repositoryRoot: "/repo",
        adapter,
        budgets: { workerCalls: 2, reviewerCalls: 2, repairIterations: 1 },
      },
      {
        verify: async () => [check("passed")],
        diff: async () => "diff --git a/src/greet.ts b/src/greet.ts",
      },
    );
    expect(record.status).toBe("completed");
    expect(record.reviewDecision).toBeUndefined();
    expect(adapter.roles).toEqual(["worker"]);
  });

  it("bounds one reviewer-requested repair and re-verifies before re-review", async () => {
    const adapter = new FakeAdapter(true);
    let verifies = 0;
    const record = await orchestrateRun(
      {
        id: "task-2",
        task: context.task,
        context,
        cwd: "/repo",
        repositoryRoot: "/repo",
        adapter,
        budgets: { workerCalls: 2, reviewerCalls: 2, repairIterations: 1 },
      },
      {
        verify: async () => {
          verifies += 1;
          return [check("passed")];
        },
        diff: async () => "diff --git a/src/auth/session.ts b/src/auth/session.ts",
      },
    );
    expect(adapter.roles).toEqual(["worker", "reviewer", "repair", "reviewer"]);
    expect(verifies).toBe(2);
    expect(record.status).toBe("approved");
  });

  it("preserves a dirty source checkout while creating isolation", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await exec("git", ["init"], { cwd: root });
    await exec("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
    await exec("git", ["config", "user.name", "Fixture"], { cwd: root });
    await writeFile(path.join(root, "README.md"), "# Fixture\n");
    await exec("git", ["add", "README.md"], { cwd: root });
    await exec("git", ["commit", "-m", "initial"], { cwd: root });
    await writeFile(path.join(root, "dirty.txt"), "preserve me");
    const isolated = await prepareIsolatedWorktree(root, "change greeting", "20260101-abcdef12");
    expect(isolated.branch).toMatch(/^noxroot\/change-greeting-/);
    expect(isolated.dirtySourceWorktree).toBe(true);
    expect(await readFile(path.join(root, "dirty.txt"), "utf8")).toBe("preserve me");
    await expect(readFile(path.join(isolated.path, "dirty.txt"), "utf8")).rejects.toThrow();
  });

  it("includes worker-created untracked files in the connected reviewer diff", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await exec("git", ["init"], { cwd: root });
    await exec("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
    await exec("git", ["config", "user.name", "Fixture"], { cwd: root });
    await writeFile(path.join(root, "README.md"), "# Fixture\n");
    await exec("git", ["add", "README.md"], { cwd: root });
    await exec("git", ["commit", "-m", "initial"], { cwd: root });
    const isolated = await prepareIsolatedWorktree(root, "add profile card", "20260101-1234abcd");
    await mkdir(path.join(isolated.path, "src", "components"), { recursive: true });
    await writeFile(
      path.join(isolated.path, "src", "components", "Profile card.tsx"),
      "export function ProfileCard() { return <section>Profile</section>; }\n",
    );

    const diff = await boundedDiff(isolated);
    expect(diff).toContain("diff --git a/src/components/Profile card.tsx");
    expect(diff).toContain("ProfileCard");
  });

  it("redacts untracked secret and configured-sensitive content from reviewer evidence", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await exec("git", ["init"], { cwd: root });
    await exec("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
    await exec("git", ["config", "user.name", "Fixture"], { cwd: root });
    await writeFile(path.join(root, "README.md"), "# Fixture\n");
    await exec("git", ["add", "README.md"], { cwd: root });
    await exec("git", ["commit", "-m", "initial"], { cwd: root });
    const isolated = await prepareIsolatedWorktree(root, "protect evidence", "20260101-deadbeef");
    await mkdir(path.join(isolated.path, "runtime"), { recursive: true });
    await writeFile(path.join(isolated.path, ".env"), "TOKEN=never-copy-this\n");
    await writeFile(path.join(isolated.path, "runtime", "session.json"), '{"user":"private"}\n');

    const diff = await boundedDiff(isolated, ["runtime/**"]);
    expect(diff).toContain("Content omitted for sensitive path .env.");
    expect(diff).toContain("Content omitted for sensitive path runtime/session.json.");
    expect(diff).not.toContain("never-copy-this");
    expect(diff).not.toContain('"user":"private"');
  });

  it("redacts tracked secret and configured-sensitive patches from reviewer evidence", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await exec("git", ["init"], { cwd: root });
    await exec("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
    await exec("git", ["config", "user.name", "Fixture"], { cwd: root });
    await mkdir(path.join(root, "runtime"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# Fixture\n");
    await writeFile(path.join(root, ".env"), "TOKEN=old-secret\n");
    await writeFile(path.join(root, "runtime", "session.json"), '{"user":"old"}\n');
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "-m", "initial"], { cwd: root });
    const isolated = await prepareIsolatedWorktree(root, "protect patches", "20260101-cafebabe");
    await writeFile(path.join(isolated.path, ".env"), "TOKEN=new-secret\n");
    await writeFile(path.join(isolated.path, "runtime", "session.json"), '{"user":"new"}\n');

    const diff = await boundedDiff(isolated, ["runtime/**"]);
    expect(diff).toContain("Content omitted for sensitive path .env.");
    expect(diff).toContain("Content omitted for sensitive path runtime/session.json.");
    expect(diff).not.toContain("old-secret");
    expect(diff).not.toContain("new-secret");
    expect(diff).not.toContain('"user":"old"');
    expect(diff).not.toContain('"user":"new"');
  });

  it("does not turn a one-off verification gap into project knowledge", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const run: RunRecord = {
      id: "task-3",
      task: "private task text is not persisted",
      status: "approved",
      calls: [],
      verification: [],
      verificationGaps: ["No approved deterministic checks matched the change."],
      handoff: "",
    };
    const result = await proposeLearnings(root, run);
    expect(result.proposals).toEqual([]);
    expect(result.message).toBe("No durable learning identified");
    await expect(readFile(path.join(root, ".noxroot", "knowledge"))).rejects.toThrow();
  });

  it("accepts only structured reviewer candidates and protects external documentation", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const run: RunRecord = {
      id: "task-structured",
      task: "raw prose must not become memory",
      status: "approved",
      verification: [],
      verificationGaps: [],
      handoff: "",
      calls: [
        {
          role: "reviewer",
          result: {
            invoked: true,
            status: "completed",
            summary: "review complete",
            output: "structured JSON was parsed earlier",
            exitCode: 0,
            reviewDecision: "approved",
            review: {
              decision: "approved",
              summary: "review complete",
              findings: [],
              learningCandidates: [
                {
                  kind: "decision",
                  destination: ".noxroot/knowledge/learnings.md",
                  evidence: ["tests/decision.test.ts proves the boundary"],
                  expectedValue: "Prevents accidental reversal of the boundary.",
                  content: "Keep project knowledge separate from runtime session state.",
                  whyNotExecutable: "The boundary is also tested; this note records the rationale.",
                },
                {
                  kind: "knowledge",
                  destination: "docs/architecture.md",
                  evidence: ["source module boundary"],
                  expectedValue: "Would alter user-authored docs.",
                  content: "Do not apply this automatically.",
                  whyNotExecutable: "Architecture rationale is not fully executable.",
                },
                {
                  kind: "none",
                  destination: ".noxroot/knowledge/learnings.md",
                  evidence: ["routine session detail"],
                  expectedValue: "none",
                  content: "Do not persist.",
                  whyNotExecutable: "No durable value.",
                },
              ],
            },
          },
        },
      ],
    };
    const result = await proposeLearnings(root, run);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      kind: "decision",
      conflict: "none",
      duplication: "not-found",
    });
    expect(result.proposals[0]?.content).not.toContain(run.task);
    expect(result.proposals[0]?.content).toContain("Last confirmed:");
    expect(result.proposals[0]?.content).toContain("Source task: task-structured");
    expect(result.rejected).toEqual([
      {
        destination: "docs/architecture.md",
        reason: "Learning may update only a Noxroot-owned Markdown file under .noxroot/knowledge/.",
      },
    ]);
  });

  it("stops learning growth when the destination needs consolidation", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, ".noxroot", "knowledge"), { recursive: true });
    await writeFile(
      path.join(root, ".noxroot", "config.yml"),
      "version: 1\nmodules: [learning]\ncontext:\n  budgetBytes: 16000\n  documentWarningBytes: 500\n",
    );
    await writeFile(
      path.join(root, ".noxroot", "knowledge", "learnings.md"),
      `# Validated learnings\n\n${"Existing durable knowledge. ".repeat(14)}\n`,
    );
    const run: RunRecord & { finishedAt: string; learningCandidates: unknown[] } = {
      id: "task-cap",
      task: "do not persist this prompt",
      status: "approved",
      finishedAt: "2026-09-03T12:00:00.000Z",
      calls: [],
      verification: [],
      verificationGaps: [],
      handoff: "",
      learningCandidates: [
        {
          kind: "knowledge",
          destination: ".noxroot/knowledge/learnings.md",
          evidence: ["tests/retention.test.ts validates the bound"],
          expectedValue: "Keeps future context small.",
          content: "Retain only durable and currently validated project knowledge.",
          whyNotExecutable: "This records the repository rationale for the executable bound.",
        },
      ],
    };

    const result = await proposeLearnings(root, run);

    expect(result.proposals).toEqual([]);
    expect(result.rejected).toEqual([
      {
        destination: ".noxroot/knowledge/learnings.md",
        reason:
          "The destination would exceed 500 bytes. Consolidate or supersede existing knowledge before adding another entry.",
      },
    ]);
  });

  it("rechecks the document bound before applying an approved proposal", async () => {
    const root = await temporaryDirectory();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, ".noxroot", "knowledge"), { recursive: true });
    await writeFile(
      path.join(root, ".noxroot", "config.yml"),
      "version: 1\nmodules: [learning]\ncontext:\n  budgetBytes: 16000\n  documentWarningBytes: 300\n",
    );
    const proposal = {
      id: "knowledge-test",
      signature: "1234567890abcdef1234",
      destination: ".noxroot/knowledge/learnings.md",
      kind: "knowledge" as const,
      evidence: ["test evidence"],
      expectedFutureValue: "future value",
      duplication: "not-found" as const,
      conflict: "none" as const,
      content: "x".repeat(400),
      executableDestination: "test",
    };

    await expect(applyLearning(root, proposal)).rejects.toThrow("would exceed 300 bytes");
    await expect(
      readFile(path.join(root, ".noxroot", "knowledge", "learnings.md")),
    ).rejects.toThrow();
  });
});
