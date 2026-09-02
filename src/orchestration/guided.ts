import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentAdapter, AgentResult, ReviewerResponse } from "../adapters/agents.js";
import { parseReviewerResponse } from "../adapters/agents.js";
import { captureRepositoryBaseline, diffFromRevision } from "../adapters/vcs.js";
import type { ContextPackage, VerificationCommand, VerificationResult } from "../model.js";
import { resolveWithin } from "../security/paths.js";
import { changedFiles, executeVerification, selectVerification } from "../verification/index.js";
import type { EffectiveAutonomy } from "./autonomy.js";
import type { RunRecord } from "./run.js";

export interface GuidedRunRecord extends RunRecord {
  mode: "guided";
  repository: { root: string };
  baseline: { revision: string; status: string };
  context: ContextPackage;
  effectiveAutonomy: EffectiveAutonomy;
  trustedVerificationPolicy: VerificationCommand[];
  verificationPolicyHash: string;
  startedAt: string;
  finishedAt?: string;
  changedPaths?: string[];
  diffHash?: string;
  reviewerPackage?: unknown;
  learningCandidates?: ReviewerResponse["learningCandidates"];
}

function policyHash(policy: VerificationCommand[]): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32"
      ? realpathSync(path.resolve(value)).toLowerCase()
      : realpathSync(path.resolve(value));
  return normalize(left) === normalize(right);
}

function guidedHandoff(
  record: GuidedRunRecord,
  checks: VerificationResult[],
  review?: ReviewerResponse,
): string {
  return [
    "TASK",
    record.task,
    "",
    "STATUS",
    record.status,
    "",
    "CHANGED",
    record.changedPaths?.join("\n") || "No changed paths were detected.",
    "",
    "VERIFIED",
    checks.map((result) => `${result.command.id}: ${result.status}`).join("\n") ||
      "No applicable approved deterministic checks ran.",
    "",
    "REVIEW",
    review ? `${review.decision}: ${review.summary}` : "Independent review is still required.",
    "",
    "NEXT",
    record.status === "review-pending"
      ? `Have a fresh reviewer return the strict JSON contract, then run noxroot finish --task ${record.id} --review-file <repository-relative-json>.`
      : `Run noxroot learn --task ${record.id} to inspect durable learning proposals.`,
  ].join("\n");
}

export async function startGuidedRun(input: {
  id: string;
  task: string;
  root: string;
  context: ContextPackage;
  effectiveAutonomy: EffectiveAutonomy;
  trustedVerificationPolicy: VerificationCommand[];
}): Promise<GuidedRunRecord> {
  const baseline = await captureRepositoryBaseline(input.root);
  if (baseline.status.trim()) {
    throw new Error(
      "Guided task recording requires a clean baseline so finish can attribute the resulting diff.",
    );
  }
  const partial: GuidedRunRecord = {
    id: input.id,
    task: input.task,
    mode: "guided",
    status: "running",
    repository: { root: baseline.root },
    baseline: { revision: baseline.revision, status: baseline.status },
    context: input.context,
    effectiveAutonomy: input.effectiveAutonomy,
    trustedVerificationPolicy: input.trustedVerificationPolicy,
    verificationPolicyHash: policyHash(input.trustedVerificationPolicy),
    startedAt: new Date().toISOString(),
    calls: [],
    verification: [],
    verificationGaps: [],
    handoff: `Guided task ${input.id} started. Next: noxroot finish --task ${input.id}`,
  };
  return partial;
}

export async function finishGuidedRun(input: {
  root: string;
  record: GuidedRunRecord;
  adapter: AgentAdapter;
  reviewAuthorized: boolean;
  reviewFile?: string;
  signal?: AbortSignal;
}): Promise<GuidedRunRecord> {
  const { record } = input;
  if (record.mode !== "guided") throw new Error("The task is not a guided run record.");
  if (!samePath(input.root, record.repository.root)) {
    throw new Error("The task belongs to a different repository identity.");
  }
  if (policyHash(record.trustedVerificationPolicy) !== record.verificationPolicyHash) {
    throw new Error("The recorded verification policy snapshot is invalid.");
  }
  const changedPaths = await changedFiles(input.root, record.baseline.revision);
  for (const changedPath of changedPaths) resolveWithin(input.root, changedPath);
  const diff = await diffFromRevision(input.root, record.baseline.revision);
  const diffHash = createHash("sha256").update(diff).digest("hex");
  const commands = selectVerification(record.trustedVerificationPolicy, changedPaths);
  const checks = await executeVerification(input.root, commands, {
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const next: GuidedRunRecord = {
    ...record,
    changedPaths,
    diffHash,
    verification: [...record.verification, checks],
    verificationGaps: [],
  };

  if (changedPaths.length === 0) {
    next.status = "blocked";
    next.verificationGaps = ["No repository change was detected from the recorded baseline."];
    next.handoff = guidedHandoff(next, checks);
    return next;
  }
  if (checks.length === 0) {
    next.status = "blocked";
    next.verificationGaps = ["No approved deterministic checks matched the actual change."];
    next.handoff = guidedHandoff(next, checks);
    return next;
  }
  if (checks.some((result) => result.status === "unavailable")) {
    next.status = "blocked";
    next.verificationGaps = checks
      .filter((result) => result.status === "unavailable")
      .map(
        (result) =>
          `Approved check ${result.command.id} was unavailable: ${result.evidence.stderr || result.command.executable}`,
      );
    next.handoff = guidedHandoff(next, checks);
    return next;
  }
  if (checks.some((result) => result.status !== "passed")) {
    next.status = "failed";
    next.verificationGaps = ["At least one affected approved deterministic check did not pass."];
    next.handoff = guidedHandoff(next, checks);
    return next;
  }

  const reviewerPackage = {
    task: record.task,
    context: record.context,
    changedPaths,
    diff,
    verification: checks,
    responseContract: {
      decision: "approved | changes-requested | blocked",
      summary: "short factual summary",
      findings: ["severity, optional path, evidence, requiredOutcome"],
      learningCandidates: [],
    },
  };
  next.reviewerPackage = reviewerPackage;
  let reviewResult: AgentResult | undefined;
  if (input.reviewFile) {
    const source = await readFile(resolveWithin(input.root, input.reviewFile), "utf8");
    const review = parseReviewerResponse(source);
    reviewResult = review
      ? {
          invoked: false,
          status: "completed",
          summary: review.summary,
          output: source,
          exitCode: 0,
          reviewDecision: review.decision,
          review,
        }
      : {
          invoked: false,
          status: "failed",
          summary: "External reviewer file was not one schema-valid JSON response.",
          output: source,
          exitCode: null,
          reviewDecision: "blocked",
        };
  } else if (input.adapter.mode === "command" && input.reviewAuthorized) {
    reviewResult = await input.adapter.invoke({
      role: "reviewer",
      package: reviewerPackage,
      cwd: input.root,
      repositoryRoot: input.root,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  if (!reviewResult) {
    next.status = "review-pending";
    next.verificationGaps = [
      "Affected checks passed; an independent reviewer decision is pending.",
    ];
    next.handoff = guidedHandoff(next, checks);
    return next;
  }
  next.calls = [...record.calls, { role: "reviewer", result: reviewResult }];
  const review = reviewResult.review;
  next.reviewDecision = reviewResult.reviewDecision;
  next.learningCandidates = review?.learningCandidates ?? [];
  next.status =
    reviewResult.status !== "completed" || !review
      ? "blocked"
      : review.decision === "approved"
        ? "approved"
        : review.decision;
  next.finishedAt = new Date().toISOString();
  next.handoff = guidedHandoff(next, checks, review);
  return next;
}
