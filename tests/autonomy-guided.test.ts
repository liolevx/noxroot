import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CommanderError } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { effectiveAutonomy } from "../src/orchestration/autonomy.js";
import { finishGuidedRun, startGuidedRun } from "../src/orchestration/guided.js";
import { ManualAgentAdapter } from "../src/adapters/agents.js";
import { runProcess } from "../src/adapters/process.js";
import { temporaryDirectory } from "./helpers.js";
import { createProgram } from "../src/cli.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  process.exitCode = 0;
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

async function cli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const program = createProgram({
    stdout: (value) => (stdout += value),
    stderr: (value) => (stderr += value),
    isTTY: false,
  });
  try {
    await program.parseAsync(["node", "noxroot", ...args]);
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
  }
  return { stdout, stderr };
}

const context = {
  task: "change value",
  interpretation: "Change the value implementation.",
  intent: {
    requiredOutcomes: ["change value"],
    explicitExclusions: [],
    requestedAuthority: [],
    acceptanceCriteria: [],
  },
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
    expect(effectiveAutonomy(undefined).worker.authorized).toBe(false);
  });

  it("completes the public guided CLI journey through a learning proposal", async () => {
    const root = await repository();
    await mkdir(path.join(root, ".noxroot", "knowledge"), { recursive: true });
    await writeFile(
      path.join(root, ".noxroot", "config.yml"),
      `version: 1
modules: [repository-profile, agent-routing, verification, orchestration, learning]
autonomy: {default: 0, implementation: 1, review: 0, merge: 0, delivery: 0}
agents: {default: manual, adapters: {manual: {type: manual}}}
`,
    );
    await writeFile(
      path.join(root, ".noxroot", "verification.yml"),
      `version: 1
commands:
  - id: node-check
    executable: ${JSON.stringify(process.execPath)}
    args: [-e, process.exit(0)]
    cwd: .
    timeoutMs: 10000
    appliesTo: [src/**]
`,
    );
    await writeFile(path.join(root, ".noxroot", "knowledge", "INDEX.md"), "# Index\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "noxroot fixture"]);

    const started = await cli(["start", "change value", "--json", "--root", root]);
    const startValue = JSON.parse(started.stdout) as { record: { id: string; status: string } };
    expect(startValue.record.status).toBe("running");
    expect(started.stderr).toBe("");
    await writeFile(path.join(root, "src", "value.ts"), "export const value = 4;\n");

    const pending = await cli(["finish", "--json", "--root", root]);
    const pendingValue = JSON.parse(pending.stdout) as {
      record: { status: string; calls: unknown[] };
      completion: { documentation: { status: string }; learning: { status: string } };
    };
    expect(pendingValue.record.status).toBe("completed");
    expect(pendingValue.record.calls).toEqual([]);
    expect(pendingValue.completion.documentation.status).toBe("not-assessed");
    expect(pendingValue.completion.learning.status).toBe("no-candidate");

    const reviewPath = path.join(root, ".noxroot", "local", "external-review.json");
    await writeFile(
      reviewPath,
      JSON.stringify({
        decision: "approved",
        summary: "The actual diff and affected check passed.",
        findings: [],
        learningCandidates: [
          {
            kind: "procedure",
            destination: ".noxroot/knowledge/learnings.md",
            evidence: ["node-check passed for src/value.ts"],
            expectedValue: "Keeps the recurring value-change check discoverable.",
            content: "Use the approved node-check for changes under src.",
            whyNotExecutable: "The executable rule already lives in verification policy.",
          },
        ],
      }),
    );
    const approved = await cli([
      "finish",
      "--task",
      startValue.record.id,
      "--review-file",
      ".noxroot/local/external-review.json",
      "--json",
      "--root",
      root,
    ]);
    const approvedRecord = (
      JSON.parse(approved.stdout) as {
        record: { status: string; handoff: string };
      }
    ).record;
    expect(approvedRecord.status).toBe("approved");
    expect(approvedRecord.handoff).toContain("1 documentation candidate identified by review");
    expect(approvedRecord.handoff).not.toContain("candidate(s) proposed");
    const learned = await cli(["learn", "--task", startValue.record.id, "--json", "--root", root]);
    const learning = JSON.parse(learned.stdout) as { proposals: Array<{ kind: string }> };
    expect(learning.proposals).toEqual([expect.objectContaining({ kind: "procedure" })]);

    const applied = await cli([
      "learn",
      "--task",
      startValue.record.id,
      "--apply",
      "--yes",
      "--json",
      "--root",
      root,
    ]);
    expect((JSON.parse(applied.stdout) as { applied: string[] }).applied).toEqual([
      ".noxroot/knowledge/learnings.md",
      ".noxroot/knowledge/INDEX.md",
    ]);
    await git(root, ["add", ".noxroot/knowledge"]);
    await git(root, ["commit", "-m", "document validated source check"]);

    const later = JSON.parse(
      (await cli(["context", "change another value under src", "--json", "--root", root])).stdout,
    ) as { selected: Array<{ path: string }> };
    expect(later.selected.map((item) => item.path)).toContain(".noxroot/knowledge/learnings.md");
    expect(later.selected.some((item) => item.path.includes(".noxroot/local/"))).toBe(false);
  });

  it("requires an explicit id when multiple guided tasks are active", async () => {
    const root = await repository();
    await mkdir(path.join(root, ".noxroot"), { recursive: true });
    await writeFile(
      path.join(root, ".noxroot", "config.yml"),
      `version: 1
modules: [repository-profile, agent-routing, orchestration]
autonomy: {default: 0, implementation: 1, review: 0, merge: 0, delivery: 0}
agents: {default: manual, adapters: {manual: {type: manual}}}
`,
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "noxroot fixture"]);
    await cli(["start", "first task", "--json", "--root", root]);
    await cli(["start", "second task", "--json", "--root", root]);
    await expect(cli(["finish", "--json", "--root", root])).rejects.toThrow(
      "Multiple active guided tasks need an explicit --task id",
    );
  });

  it("continues the same active task without creating a duplicate record", async () => {
    const root = await repository();
    await mkdir(path.join(root, ".noxroot"), { recursive: true });
    await writeFile(
      path.join(root, ".noxroot", "config.yml"),
      `version: 1
modules: [repository-profile, agent-routing, orchestration]
autonomy: {default: 0, implementation: 1, review: 0, merge: 0, delivery: 0}
agents: {default: manual, adapters: {manual: {type: manual}}}
`,
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "noxroot fixture"]);

    const first = JSON.parse(
      (await cli(["start", "Change the value safely", "--json", "--root", root])).stdout,
    ) as { record: { id: string } };
    await writeFile(path.join(root, "src", "value.ts"), "export const value = 2;\n");
    const second = JSON.parse(
      (await cli(["start", "  change the VALUE safely. ", "--json", "--root", root])).stdout,
    ) as {
      record: { id: string };
      continued: boolean;
      continuation: {
        changedPaths: string[];
        verification: { status: string; current: boolean };
        nextAction: string;
      };
    };

    expect(second.record.id).toBe(first.record.id);
    expect(second.continued).toBe(true);
    expect(second.continuation.changedPaths).toEqual(["src/value.ts"]);
    expect(second.continuation.verification).toMatchObject({
      status: "not-run",
      current: false,
    });
    expect(second.continuation.nextAction).toBe(
      "Run npx --yes noxroot@0.1.0 finish when the change is ready to check.",
    );
    const brief = await cli(["start", "change the value safely", "--root", root]);
    expect(brief.stdout).toContain("Changed: 1 file since baseline (src/value.ts)");
    expect(brief.stdout).toContain("Verification: Not run for the current diff.");
    expect(brief.stdout).toContain(
      "Next: Run npx --yes noxroot@0.1.0 finish when the change is ready to check.",
    );
    const records = await (
      await import("node:fs/promises")
    ).readdir(path.join(root, ".noxroot", "local", "runs"));
    expect(records.filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  it("reports current task state without changing or invoking anything", async () => {
    const root = await repository();
    const empty = await cli(["status", "--root", root]);
    expect(empty.stdout).toContain("Active tasks  none");
    expect(empty.stdout).toContain("Keep working normally with your coding agent.");

    await mkdir(path.join(root, ".noxroot"), { recursive: true });
    await writeFile(
      path.join(root, ".noxroot", "config.yml"),
      `version: 1
modules: [repository-profile, agent-routing, orchestration]
autonomy: {default: 0, implementation: 1, review: 0, merge: 0, delivery: 0}
agents: {default: manual, adapters: {manual: {type: manual}}}
`,
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "noxroot fixture"]);
    const task = "change the value; do not deploy";
    const started = JSON.parse((await cli(["start", task, "--json", "--root", root])).stdout) as {
      record: { id: string };
    };
    await writeFile(path.join(root, "src", "value.ts"), "export const value = 2;\n");

    const value = JSON.parse((await cli(["status", "--json", "--root", root])).stdout) as {
      active: Array<{
        record: { id: string };
        continuation: { changedPaths: string[]; verification: { status: string } };
      }>;
    };
    expect(value.active).toHaveLength(1);
    expect(value.active[0]?.record.id).toBe(started.record.id);
    expect(value.active[0]?.continuation.changedPaths).toEqual(["src/value.ts"]);
    expect(value.active[0]?.continuation.verification.status).toBe("not-run");

    const human = await cli(["status", "--root", root]);
    expect(human.stdout).toContain("Changed  src/value.ts");
    expect(human.stdout).toContain("Verification  Not run for the current diff.");
    expect(human.stdout).toContain(
      "Before editing  Repeat start with the active task text to check write access.",
    );
    expect(human.stdout).toContain(`${started.record.id}  ${task}\n`);
    const displayed = human.stdout
      .split("\n")
      .find((line) => line.startsWith(`${started.record.id}  `))!
      .slice(started.record.id.length + 2);
    const resumed = JSON.parse((await cli(["start", displayed, "--json", "--root", root])).stdout);
    expect(resumed.continued).toBe(true);
    expect(resumed.record.id).toBe(started.record.id);
  });

  it("reports current and stale verification deterministically when continuing", async () => {
    const root = await repository();
    await mkdir(path.join(root, "web", "components"), { recursive: true });
    await writeFile(path.join(root, "web", "components", "panel.tsx"), "export const Panel = 1;\n");
    await mkdir(path.join(root, ".noxroot"), { recursive: true });
    await writeFile(
      path.join(root, ".noxroot", "config.yml"),
      `version: 1
modules: [repository-profile, agent-routing, verification, orchestration]
autonomy: {default: 0, implementation: 1, review: 0, merge: 0, delivery: 0}
agents: {default: manual, adapters: {manual: {type: manual}}}
`,
    );
    await writeFile(
      path.join(root, ".noxroot", "verification.yml"),
      `version: 1
commands:
  - id: node-check
    executable: ${JSON.stringify(process.execPath)}
    args: [-e, process.exit(0)]
    cwd: .
    timeoutMs: 10000
    appliesTo: [web/**]
`,
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "noxroot fixture"]);

    await cli(["start", "review the panel accessibility", "--json", "--root", root]);
    await writeFile(path.join(root, "web", "components", "panel.tsx"), "export const Panel = 2;\n");
    const finished = JSON.parse((await cli(["finish", "--json", "--root", root])).stdout) as {
      record: { status: string };
    };
    expect(finished.record.status).toBe("review-pending");

    const current = JSON.parse(
      (await cli(["start", "review the panel accessibility", "--json", "--root", root])).stdout,
    ) as {
      continuation: {
        changedPaths: string[];
        verification: { status: string; current: boolean };
        nextAction: string;
      };
    };
    expect(current.continuation.changedPaths).toEqual(["web/components/panel.tsx"]);
    expect(current.continuation.verification).toMatchObject({
      status: "current-passed",
      current: true,
    });
    expect(current.continuation.nextAction).toContain("required fresh review");

    await writeFile(path.join(root, "web", "components", "panel.tsx"), "export const Panel = 3;\n");
    const stale = JSON.parse(
      (await cli(["start", "review the panel accessibility", "--json", "--root", root])).stdout,
    ) as {
      continuation: {
        verification: { status: string; current: boolean };
        nextAction: string;
      };
    };
    expect(stale.continuation.verification).toMatchObject({ status: "stale", current: false });
    expect(stale.continuation.nextAction).toBe(
      "Run npx --yes noxroot@0.1.0 finish when the change is ready to check.",
    );
  });

  it("does not continue a task record from another branch", async () => {
    const root = await repository();
    await mkdir(path.join(root, ".noxroot"), { recursive: true });
    await writeFile(
      path.join(root, ".noxroot", "config.yml"),
      `version: 1
modules: [repository-profile, agent-routing, orchestration]
autonomy: {default: 0, implementation: 1, review: 0, merge: 0, delivery: 0}
agents: {default: manual, adapters: {manual: {type: manual}}}
`,
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "noxroot fixture"]);
    const first = JSON.parse(
      (await cli(["start", "change value", "--json", "--root", root])).stdout,
    ) as { record: { id: string } };
    await git(root, ["switch", "-c", "other-task-branch"]);
    const second = JSON.parse(
      (await cli(["start", "change value", "--json", "--root", root])).stdout,
    ) as { record: { id: string }; continued?: boolean };
    expect(second.record.id).not.toBe(first.record.id);
    expect(second.continued).toBeUndefined();

    await writeFile(path.join(root, "src", "value.ts"), "export const value = 8;\n");
    const finished = JSON.parse((await cli(["finish", "--json", "--root", root])).stdout) as {
      record: { id: string; status: string };
    };
    expect(finished.record.id).toBe(second.record.id);
    expect(finished.record.status).toBe("incomplete");
  });

  it("refuses to reuse stale task state from incompatible branch history", async () => {
    const root = await repository();
    await mkdir(path.join(root, ".noxroot"), { recursive: true });
    await writeFile(
      path.join(root, ".noxroot", "config.yml"),
      `version: 1
modules: [repository-profile, agent-routing, orchestration]
autonomy: {default: 0, implementation: 1, review: 0, merge: 0, delivery: 0}
agents: {default: manual, adapters: {manual: {type: manual}}}
`,
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "noxroot fixture"]);
    const started = JSON.parse(
      (await cli(["start", "change value", "--json", "--root", root])).stdout,
    ) as { record: { id: string } };
    const recordPath = path.join(root, ".noxroot", "local", "runs", `${started.record.id}.json`);
    const persisted = JSON.parse(await readFile(recordPath, "utf8")) as {
      baseline: { revision: string };
    };
    persisted.baseline.revision = "0000000000000000000000000000000000000000";
    await writeFile(recordPath, `${JSON.stringify(persisted, null, 2)}\n`);

    await expect(cli(["start", "change value", "--json", "--root", root])).rejects.toThrow(
      "baseline is not in the current branch history",
    );
    await expect(cli(["finish", "--json", "--root", root])).rejects.toThrow(
      "incompatible with the current branch history",
    );
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
    expect(pending.status).toBe("completed");
    expect(pending.changedPaths).toEqual(["src/new.ts", "src/value.ts"]);
    expect(pending.reviewerPackage).toBeUndefined();
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

  it("requests UX review for an actual interaction change even without Playwright", async () => {
    const root = await repository();
    await writeFile(path.join(root, "src", "App.tsx"), "export const App = () => <main />;\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "frontend fixture"]);
    const command = {
      id: "node-check",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: ".",
      timeoutMs: 10_000,
      appliesTo: ["src/**"],
    };
    const record = await startGuidedRun({
      id: "guided-ui",
      task: "improve the page",
      root,
      context,
      effectiveAutonomy: effectiveAutonomy(undefined),
      trustedVerificationPolicy: [command],
    });
    await writeFile(
      path.join(root, "src", "App.tsx"),
      "export const App = () => <button onClick={() => undefined}>Ready</button>;\n",
    );
    const finished = await finishGuidedRun({
      root,
      record,
      adapter: new ManualAgentAdapter(),
      reviewAuthorized: false,
    });
    expect(finished.status).toBe("review-pending");
    expect(finished.reviewAssessment).toMatchObject({ required: true, kinds: ["ux"] });
    expect(JSON.stringify(finished.reviewerPackage)).toContain("<button onClick");
  });

  it("does not require review for a bounded UI copy change", async () => {
    const root = await repository();
    await writeFile(
      path.join(root, "src", "App.tsx"),
      "export const App = () => <main>Old</main>;\n",
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "frontend fixture"]);
    const command = {
      id: "node-check",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: ".",
      timeoutMs: 10_000,
      appliesTo: ["src/**"],
    };
    const record = await startGuidedRun({
      id: "guided-ui-copy",
      task: "update the page label",
      root,
      context,
      effectiveAutonomy: effectiveAutonomy(undefined),
      trustedVerificationPolicy: [command],
    });
    await writeFile(
      path.join(root, "src", "App.tsx"),
      "export const App = () => <main>Ready</main>;\n",
    );

    const finished = await finishGuidedRun({
      root,
      record,
      adapter: new ManualAgentAdapter(),
      reviewAuthorized: false,
    });

    expect(finished.status).toBe("completed");
    expect(finished.reviewAssessment).toEqual({ required: false, kinds: [], reasons: [] });
  });

  it("permits an incomplete handoff without approving when no check matches", async () => {
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
    expect(finished.status).toBe("incomplete");
    expect(finished.reviewDecision).not.toBe("approved");
    expect(finished.verificationGaps).toContain(
      "No approved deterministic checks matched the actual change.",
    );
  });

  it("keeps passing-check output out of the concise handoff", async () => {
    const root = await repository();
    const record = await startGuidedRun({
      id: "guided-clean-output",
      task: "change value",
      root,
      context,
      effectiveAutonomy: effectiveAutonomy(undefined),
      trustedVerificationPolicy: [
        {
          id: "node-check",
          executable: process.execPath,
          args: ["-e", "process.stderr.write('harmless warning')"],
          cwd: ".",
          timeoutMs: 10_000,
          appliesTo: ["src/**"],
        },
      ],
    });
    await writeFile(path.join(root, "src", "value.ts"), "export const value = 3;\n");

    const finished = await finishGuidedRun({
      root,
      record,
      adapter: new ManualAgentAdapter(),
      reviewAuthorized: false,
    });

    expect(finished.handoff).toContain("node-check: passed");
    expect(finished.handoff).not.toContain("exit 0 | harmless warning");
    expect(finished.verification[0]?.[0]?.evidence.stderr).toContain("harmless warning");
  });

  it("shows an unavailable command, cwd, failure, and retry in the human handoff", async () => {
    const root = await repository();
    await mkdir(path.join(root, ".noxroot"), { recursive: true });
    await writeFile(
      path.join(root, ".noxroot", "config.yml"),
      `version: 1
modules: [repository-profile, verification, orchestration, learning]
autonomy: {default: 0, implementation: 1, review: 0, merge: 0, delivery: 0}
agents: {default: manual, adapters: {manual: {type: manual}}}
`,
    );
    await writeFile(
      path.join(root, ".noxroot", "verification.yml"),
      `version: 1
commands:
  - id: missing-check
    executable: definitely-not-installed-noxroot-check
    args: [--verify]
    cwd: .
    timeoutMs: 1000
    appliesTo: [src/**]
`,
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "noxroot verification fixture"]);
    await cli(["start", "change value", "--root", root]);
    await writeFile(path.join(root, "src", "value.ts"), "export const value = 9;\n");

    const result = await cli(["finish", "--root", root]);
    expect(result.stdout).toContain(
      "definitely-not-installed-noxroot-check --verify · cwd . · unavailable",
    );
    expect(result.stdout).toContain("Make the approved check runnable");
    expect(result.stdout).toContain("rerun npx --yes noxroot@0.1.0 finish.");
    expect(result.stderr).toContain("Inspecting changed files and running affected checks");
    expect(result.stderr).toContain("Assessing reusable learning");
    expect(result.stderr).toContain("Preparing handoff");
    expect(process.exitCode).toBe(4);
  });
});
