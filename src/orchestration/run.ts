import type { AgentAdapter, AgentResult } from "../adapters/agents.js";
import type { ContextPackage, VerificationResult } from "../model.js";
import { cliCommand } from "../invocation.js";
import { assessReviewNeed } from "./review.js";

export interface RunBudgets {
  workerCalls: number;
  reviewerCalls: number;
  repairIterations: number;
}

export interface RunRecord {
  id: string;
  task: string;
  status:
    | "running"
    | "review-pending"
    | "approved"
    | "completed"
    | "changes-requested"
    | "failed"
    | "blocked"
    | "incomplete"
    | "manual";
  branch?: string;
  worktree?: string;
  calls: Array<{ role: "worker" | "reviewer" | "repair"; result: AgentResult }>;
  verification: VerificationResult[][];
  verificationGaps: string[];
  reviewDecision?: AgentResult["reviewDecision"];
  handoff: string;
}

export interface OrchestrationRequest {
  id: string;
  task: string;
  context: ContextPackage;
  cwd: string;
  repositoryRoot: string;
  adapter: AgentAdapter;
  budgets: RunBudgets;
  reviewAuthorized?: boolean;
  branch?: string;
  signal?: AbortSignal;
}

export interface OrchestrationDependencies {
  verify: () => Promise<VerificationResult[]>;
  diff: () => Promise<string>;
  changeId: () => Promise<string>;
  unmatchedPaths: () => Promise<string[]>;
}

async function stableReviewEvidence(
  dependencies: OrchestrationDependencies,
): Promise<{ diff: string; changeId: string } | undefined> {
  const before = await dependencies.changeId();
  const diff = await dependencies.diff();
  return (await dependencies.changeId()) === before ? { diff, changeId: before } : undefined;
}

async function stableVerificationCoverage(
  dependencies: OrchestrationDependencies,
): Promise<{ changeId: string; unmatchedPaths: string[] } | undefined> {
  const before = await dependencies.changeId();
  const unmatchedPaths = await dependencies.unmatchedPaths();
  return (await dependencies.changeId()) === before
    ? { changeId: before, unmatchedPaths }
    : undefined;
}

function passed(results: VerificationResult[]): boolean {
  return results.length > 0 && results.every((result) => result.status === "passed");
}

function handoff(record: Omit<RunRecord, "handoff">): string {
  const changed = record.worktree ?? "No isolated worktree was created.";
  const verified = record.verification.flat().map((item) => `${item.command.id}: ${item.status}`);
  return [
    "TASK",
    record.task,
    "",
    "STATUS",
    record.status,
    "",
    "CHANGED",
    changed,
    "",
    "DECISIONS",
    record.reviewDecision ?? "No reviewer decision.",
    "",
    "VERIFIED",
    verified.join("\n") || "No approved deterministic checks were available.",
    "",
    "NOT VERIFIED",
    record.verificationGaps.join("\n") || "No declared gaps beyond the scope of configured checks.",
    "",
    "REVIEW FINDINGS",
    record.calls
      .filter((call) => call.role === "reviewer")
      .map((call) => call.result.summary)
      .join("\n") || "No independent reviewer was invoked.",
    "",
    "RISKS",
    record.status === "approved" || record.status === "completed"
      ? "Passing evidence is limited to the checks listed above."
      : "Human review is required.",
    "",
    "NEXT",
    record.branch
      ? `Review branch ${record.branch}; Noxroot did not merge or push it.`
      : "Review the generated package or worktree; Noxroot did not merge or push it.",
    "",
    "LEARNING PROPOSALS",
    record.verificationGaps.length
      ? `Review the verification gaps with ${cliCommand("learn")}.`
      : "No durable learning identified.",
  ].join("\n");
}

export async function orchestrateRun(
  request: OrchestrationRequest,
  dependencies: OrchestrationDependencies,
): Promise<RunRecord> {
  const calls: RunRecord["calls"] = [];
  const verification: VerificationResult[][] = [];
  const verificationGaps: string[] = [];
  if (request.adapter.mode === "manual") {
    const result = await request.adapter.invoke({
      role: "worker",
      package: request.context,
      cwd: request.cwd,
      repositoryRoot: request.repositoryRoot,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    calls.push({ role: "worker", result });
    const partial: Omit<RunRecord, "handoff"> = {
      id: request.id,
      task: request.task,
      status: "manual",
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      worktree: request.cwd,
      calls,
      verification,
      verificationGaps: ["Manual package was not executed or reviewed by Noxroot."],
    };
    return { ...partial, handoff: handoff(partial) };
  }

  if (request.budgets.workerCalls < 1)
    throw new Error("Worker-call budget does not allow implementation.");
  const worker = await request.adapter.invoke({
    role: "worker",
    package: request.context,
    cwd: request.cwd,
    repositoryRoot: request.repositoryRoot,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  calls.push({ role: "worker", result: worker });
  if (worker.status !== "completed") {
    const partial: Omit<RunRecord, "handoff"> = {
      id: request.id,
      task: request.task,
      status: "failed",
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      worktree: request.cwd,
      calls,
      verification,
      verificationGaps: [
        "Worker did not complete, so deterministic checks and review were not run.",
      ],
    };
    return { ...partial, handoff: handoff(partial) };
  }

  let coverage = await stableVerificationCoverage(dependencies);
  if (!coverage) {
    verificationGaps.push("The repository changed while verification coverage was inspected.");
  } else if (coverage.unmatchedPaths.length > 0) {
    verificationGaps.push(`No approved check applies to: ${coverage.unmatchedPaths.join(", ")}.`);
  }
  if (verificationGaps.length > 0) {
    const partial: Omit<RunRecord, "handoff"> = {
      id: request.id,
      task: request.task,
      status: "incomplete",
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      worktree: request.cwd,
      calls,
      verification,
      verificationGaps,
    };
    return { ...partial, handoff: handoff(partial) };
  }
  let verificationChangeId = coverage!.changeId;
  let checkResults = await dependencies.verify();
  let verificationStable =
    verificationChangeId !== undefined && (await dependencies.changeId()) === verificationChangeId;
  verification.push(checkResults);
  if (!verificationStable) {
    verificationGaps.push(
      verificationChangeId
        ? "The repository changed while approved checks ran; their evidence is stale."
        : "A complete change id was unavailable for verification.",
    );
    const partial: Omit<RunRecord, "handoff"> = {
      id: request.id,
      task: request.task,
      status: "incomplete",
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      worktree: request.cwd,
      calls,
      verification,
      verificationGaps,
    };
    return { ...partial, handoff: handoff(partial) };
  }
  if (checkResults.length === 0) {
    verificationGaps.push("No approved deterministic checks matched the change.");
    const partial: Omit<RunRecord, "handoff"> = {
      id: request.id,
      task: request.task,
      status: "incomplete",
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      worktree: request.cwd,
      calls,
      verification,
      verificationGaps,
    };
    return { ...partial, handoff: handoff(partial) };
  }
  if (checkResults.some((result) => result.status === "unavailable")) {
    verificationGaps.push(
      ...checkResults
        .filter((result) => result.status === "unavailable")
        .map(
          (result) =>
            `Approved check ${result.command.id} was unavailable: ${result.evidence.stderr || result.command.executable}`,
        ),
    );
    const partial: Omit<RunRecord, "handoff"> = {
      id: request.id,
      task: request.task,
      status: "incomplete",
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      worktree: request.cwd,
      calls,
      verification,
      verificationGaps,
    };
    return { ...partial, handoff: handoff(partial) };
  }
  while (
    !passed(checkResults) &&
    calls.filter((call) => call.role === "repair").length < request.budgets.repairIterations &&
    calls.filter((call) => call.role === "worker" || call.role === "repair").length <
      request.budgets.workerCalls
  ) {
    const repair = await request.adapter.invoke({
      role: "repair",
      package: { context: request.context, failedChecks: checkResults },
      cwd: request.cwd,
      repositoryRoot: request.repositoryRoot,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    calls.push({ role: "repair", result: repair });
    if (repair.status !== "completed") break;
    coverage = await stableVerificationCoverage(dependencies);
    if (!coverage || coverage.unmatchedPaths.length > 0) {
      verificationStable = false;
      verificationGaps.push(
        coverage
          ? `No approved check applies to: ${coverage.unmatchedPaths.join(", ")}.`
          : "The repository changed while verification coverage was inspected.",
      );
      break;
    }
    verificationChangeId = coverage.changeId;
    checkResults = await dependencies.verify();
    verificationStable =
      verificationChangeId !== undefined &&
      (await dependencies.changeId()) === verificationChangeId;
    verification.push(checkResults);
    if (!verificationStable) {
      verificationGaps.push(
        verificationChangeId
          ? "The repository changed while approved checks ran; their evidence is stale."
          : "A complete change id was unavailable for verification.",
      );
      break;
    }
  }

  if (!verificationStable) {
    const partial: Omit<RunRecord, "handoff"> = {
      id: request.id,
      task: request.task,
      status: "incomplete",
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      worktree: request.cwd,
      calls,
      verification,
      verificationGaps,
    };
    return { ...partial, handoff: handoff(partial) };
  }

  if (!passed(checkResults)) {
    const partial: Omit<RunRecord, "handoff"> = {
      id: request.id,
      task: request.task,
      status: "failed",
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      worktree: request.cwd,
      calls,
      verification,
      verificationGaps,
    };
    return { ...partial, handoff: handoff(partial) };
  }

  const initialReviewEvidence = await stableReviewEvidence(dependencies);
  if (!initialReviewEvidence || initialReviewEvidence.changeId !== verificationChangeId) {
    const partial: Omit<RunRecord, "handoff"> = {
      id: request.id,
      task: request.task,
      status: "incomplete",
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      worktree: request.cwd,
      calls,
      verification,
      verificationGaps: [
        ...verificationGaps,
        "The repository changed while review evidence was captured.",
      ],
    };
    return { ...partial, handoff: handoff(partial) };
  }
  const reviewDiff = initialReviewEvidence.diff;
  const reviewAssessment = assessReviewNeed([], reviewDiff, request.task);
  if (!reviewAssessment.required) {
    const partial: Omit<RunRecord, "handoff"> = {
      id: request.id,
      task: request.task,
      status: "completed",
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      worktree: request.cwd,
      calls,
      verification,
      verificationGaps,
    };
    return { ...partial, handoff: handoff(partial) };
  }

  if (request.budgets.reviewerCalls < 1) {
    const partial: Omit<RunRecord, "handoff"> = {
      id: request.id,
      task: request.task,
      status: "blocked",
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      worktree: request.cwd,
      calls,
      verification,
      verificationGaps: [...verificationGaps, "Reviewer-call budget is zero."],
    };
    return { ...partial, handoff: handoff(partial) };
  }

  if (request.reviewAuthorized === false) {
    const partial: Omit<RunRecord, "handoff"> = {
      id: request.id,
      task: request.task,
      status: "review-pending",
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      worktree: request.cwd,
      calls,
      verification,
      verificationGaps: [
        ...verificationGaps,
        "Independent reviewer execution is not authorized; use a fresh external review.",
      ],
    };
    return { ...partial, handoff: handoff(partial) };
  }

  let reviewChangeId: string | undefined = initialReviewEvidence.changeId;
  let review = await request.adapter.invoke({
    role: "reviewer",
    package: {
      schemaVersion: 2,
      taskId: request.id,
      changeId: reviewChangeId,
      original: request.context,
      diff: reviewDiff,
      reviewAssessment,
      verification: checkResults,
      rubric: [
        "Inspect independently before relying on worker rationale.",
        "Report severity, evidence, affected path or surface, and required outcome.",
        "Return approved, changes-requested, or blocked.",
      ],
    },
    cwd: request.cwd,
    repositoryRoot: request.repositoryRoot,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  calls.push({ role: "reviewer", result: review });

  if (
    review.reviewDecision === "changes-requested" &&
    calls.filter((call) => call.role === "repair").length < request.budgets.repairIterations &&
    calls.filter((call) => call.role === "worker" || call.role === "repair").length <
      request.budgets.workerCalls
  ) {
    const repair = await request.adapter.invoke({
      role: "repair",
      package: { context: request.context, reviewer: review.output },
      cwd: request.cwd,
      repositoryRoot: request.repositoryRoot,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    calls.push({ role: "repair", result: repair });
    if (repair.status === "completed") {
      coverage = await stableVerificationCoverage(dependencies);
      if (!coverage || coverage.unmatchedPaths.length > 0) {
        verificationStable = false;
        verificationGaps.push(
          coverage
            ? `No approved check applies to: ${coverage.unmatchedPaths.join(", ")}.`
            : "The repository changed while verification coverage was inspected.",
        );
      } else {
        verificationChangeId = coverage.changeId;
        checkResults = await dependencies.verify();
        verificationStable = (await dependencies.changeId()) === verificationChangeId;
        verification.push(checkResults);
      }
      if (
        verificationStable &&
        passed(checkResults) &&
        calls.filter((call) => call.role === "reviewer").length < request.budgets.reviewerCalls
      ) {
        const repairedReviewEvidence = await stableReviewEvidence(dependencies);
        reviewChangeId =
          repairedReviewEvidence?.changeId === verificationChangeId
            ? repairedReviewEvidence.changeId
            : undefined;
        if (repairedReviewEvidence?.changeId === verificationChangeId) {
          review = await request.adapter.invoke({
            role: "reviewer",
            package: {
              schemaVersion: 2,
              taskId: request.id,
              changeId: reviewChangeId,
              original: request.context,
              diff: repairedReviewEvidence.diff,
              verification: checkResults,
              priorFindings: review.output,
            },
            cwd: request.cwd,
            repositoryRoot: request.repositoryRoot,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          });
          calls.push({ role: "reviewer", result: review });
        }
      }
    }
  }

  if (!verificationStable) {
    const partial: Omit<RunRecord, "handoff"> = {
      id: request.id,
      task: request.task,
      status: "incomplete",
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      worktree: request.cwd,
      calls,
      verification,
      verificationGaps: [
        ...verificationGaps,
        "The repository changed while approved checks ran; their evidence is stale.",
      ],
    };
    return { ...partial, handoff: handoff(partial) };
  }

  if (!reviewChangeId) {
    const partial: Omit<RunRecord, "handoff"> = {
      id: request.id,
      task: request.task,
      status: "incomplete",
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      worktree: request.cwd,
      calls,
      verification,
      verificationGaps: [
        ...verificationGaps,
        "The repository changed while review evidence was captured.",
      ],
    };
    return { ...partial, handoff: handoff(partial) };
  }
  if ((await dependencies.changeId()) !== reviewChangeId) {
    const partial: Omit<RunRecord, "handoff"> = {
      id: request.id,
      task: request.task,
      status: "blocked",
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      worktree: request.cwd,
      calls,
      verification,
      verificationGaps: [
        ...verificationGaps,
        "The repository changed during review; verification and the reviewer decision are stale.",
      ],
    };
    return { ...partial, handoff: handoff(partial) };
  }

  const status: RunRecord["status"] =
    review.status !== "completed"
      ? "failed"
      : review.reviewDecision === "approved"
        ? "approved"
        : review.reviewDecision === "blocked"
          ? "blocked"
          : "changes-requested";
  const partial: Omit<RunRecord, "handoff"> = {
    id: request.id,
    task: request.task,
    status,
    ...(request.branch === undefined ? {} : { branch: request.branch }),
    worktree: request.cwd,
    calls,
    verification,
    verificationGaps,
    ...(review.reviewDecision === undefined ? {} : { reviewDecision: review.reviewDecision }),
  };
  return { ...partial, handoff: handoff(partial) };
}
