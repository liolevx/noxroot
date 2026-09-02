import { describe, expect, it } from "vitest";
import {
  CommandAgentAdapter,
  parseReviewerResponse,
  type ReviewerResponse,
} from "../src/adapters/agents.js";
import type { ProcessEvidence } from "../src/model.js";

function response(decision: ReviewerResponse["decision"]): ReviewerResponse {
  return {
    decision,
    summary: `${decision} from deterministic fixture`,
    findings:
      decision === "changes-requested"
        ? [
            {
              severity: "high",
              path: "src/example.ts",
              evidence: "The changed branch is not covered.",
              requiredOutcome: "Cover the changed branch with a deterministic test.",
            },
          ]
        : [],
    learningCandidates: [],
  };
}

function evidence(overrides: Partial<ProcessEvidence> = {}): ProcessEvidence {
  return {
    executable: "fixture-reviewer",
    args: [],
    cwd: "/repo",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:00.001Z",
    durationMs: 1,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify(response("approved")),
    stderr: "",
    outputTruncated: false,
    ...overrides,
  };
}

describe("strict reviewer protocol", () => {
  it.each(["approved", "changes-requested", "blocked"] as const)(
    "accepts a complete schema-valid %s decision",
    (decision) => {
      expect(parseReviewerResponse(JSON.stringify(response(decision)))?.decision).toBe(decision);
    },
  );

  it.each([
    "approved",
    "not approved",
    "unapproved",
    "approval pending",
    "The result is approved.",
    '{"decision":"approved"}',
    `${JSON.stringify(response("approved"))}\nextra prose`,
    JSON.stringify({ ...response("approved"), unexpected: true }),
    JSON.stringify({ ...response("approved"), decision: "maybe" }),
    JSON.stringify({ ...response("approved"), findings: [{ severity: "high" }] }),
  ])("rejects ambiguous or incomplete output: %s", (output) => {
    expect(parseReviewerResponse(output)).toBeUndefined();
  });

  it("parses only stdout and blocks invalid output even when stderr says approved", async () => {
    const adapter = new CommandAgentAdapter(
      "fixture",
      "fixture-reviewer",
      [],
      1_000,
      8_000,
      async () =>
        evidence({ stdout: "not approved", stderr: JSON.stringify(response("approved")) }),
    );
    const result = await adapter.invoke({
      role: "reviewer",
      package: {},
      cwd: "/repo",
      repositoryRoot: "/repo",
    });
    expect(result.reviewDecision).toBe("blocked");
    expect(result.diagnostics).toContain('"decision":"approved"');
  });

  it("requires a successful, complete reviewer process before honoring a decision", async () => {
    for (const processEvidence of [
      evidence({ exitCode: 1 }),
      evidence({ outputTruncated: true }),
      evidence({ stdout: JSON.stringify(response("changes-requested")), exitCode: 2 }),
    ]) {
      const adapter = new CommandAgentAdapter(
        "fixture",
        "fixture-reviewer",
        [],
        1_000,
        8_000,
        async () => processEvidence,
      );
      const result = await adapter.invoke({
        role: "reviewer",
        package: {},
        cwd: "/repo",
        repositoryRoot: "/repo",
      });
      expect(result.reviewDecision).toBe("blocked");
    }
  });
});
