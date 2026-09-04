import { expect, it } from "vitest";
import { renderGuidedFinish } from "../src/output.js";
import type { GuidedRunRecord } from "../src/orchestration/guided.js";

function record(status: GuidedRunRecord["status"]): GuidedRunRecord {
  return {
    id: "one",
    status,
    changedPaths: ["src/value.ts"],
    calls: [],
    verificationGaps: [],
    verification: [
      [
        {
          command: { id: "unit", executable: "npm", args: ["test"], cwd: "." },
          status: status === "failed" ? "failed" : "passed",
          evidence: {
            stdout: "expected 2, received 1",
            stderr: "",
            exitCode: status === "failed" ? 1 : 0,
          },
        },
      ],
    ],
    reviewAssessment: {
      required: status === "review-pending",
      kinds: ["ux"],
      reasons: ["changed navigation"],
    },
    handoff: "Full handoff evidence",
  } as unknown as GuidedRunRecord;
}

it.each([80, 120])("keeps a routine finish short at %i columns without losing status", (width) => {
  const plain = renderGuidedFinish(record("completed"), 0, ".noxroot/local/runs/one.json", {
    width,
  });
  expect(plain.trim().split("\n").length).toBeLessThanOrEqual(12);
  expect(plain).toContain("task completed");
  expect(plain).toContain("Changed  1 file\n");
  expect(plain).toContain("npm test · cwd . · passed");
  expect(plain).toContain("Not assessed automatically");
  expect(plain).not.toContain("\u001b[");
  expect(plain).not.toContain("approved");
});

it("retains failure evidence and retry instructions in default output", () => {
  const output = renderGuidedFinish(record("failed"), 0, "record.json", {});
  expect(output).toContain("task failed");
  expect(output).toContain("expected 2, received 1");
  expect(output).toContain("Fix the failing check");
  expect(output).not.toContain("task completed");
});

it("does not turn passing checks into review approval", () => {
  const output = renderGuidedFinish(record("review-pending"), 0, "record.json", {});
  expect(output).toContain("task review-pending");
  expect(output).toContain("Pending ux review");
  expect(output).toContain("--review-file");
  expect(output).not.toContain("task completed");
});

it("keeps detailed handoff evidence available and adds no repeated banner", () => {
  const output = renderGuidedFinish(record("completed"), 1, "record.json", { verbose: true });
  expect(output).toContain("Full handoff evidence");
  expect(output).toContain("Local record: record.json");
  expect(output).not.toContain("█");
});

it("shows why an invalid reviewer response blocked completion", () => {
  const blocked = record("blocked");
  blocked.calls = [
    {
      role: "reviewer",
      result: {
        invoked: false,
        status: "failed",
        summary: "Review response was not schema-valid JSON.",
        output: "",
        exitCode: null,
        reviewDecision: "blocked",
      },
    },
  ];
  const output = renderGuidedFinish(blocked, 0, "record.json", {});
  expect(output).toContain("Review   blocked: Review response was not schema-valid JSON.");
  expect(output).not.toContain("Not required");
});
