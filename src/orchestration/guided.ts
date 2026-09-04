import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type { AgentAdapter, AgentResult, ReviewerResponse } from "../adapters/agents.js";
import { parseReviewerResponse } from "../adapters/agents.js";
import {
  captureRepositoryBaseline,
  diffFromRevision,
  identifyChange,
  isTrackedPath,
  type ChangeIdentity,
} from "../adapters/vcs.js";
import type { ContextPackage, VerificationCommand, VerificationResult } from "../model.js";
import { cliCommand } from "../invocation.js";
import { isWithin, resolveWithin } from "../security/paths.js";
import {
  changedFiles,
  executeVerification,
  selectVerification,
  unmatchedVerificationPaths,
} from "../verification/index.js";
import type { EffectiveAutonomy } from "./autonomy.js";
import type { RunRecord } from "./run.js";
import { assessReviewNeed, type ReviewAssessment } from "./review.js";
import { failureDetail, TIMEOUT_NEXT } from "../verification/diagnostics.js";

export interface GuidedRunRecord extends RunRecord {
  mode: "guided";
  repository: { root: string; branch?: string };
  baseline: { revision: string; status: string };
  context: ContextPackage;
  effectiveAutonomy: EffectiveAutonomy;
  trustedVerificationPolicy: VerificationCommand[];
  verificationPolicyHash: string;
  startedAt: string;
  finishedAt?: string;
  changedPaths?: string[];
  unmatchedChangedPaths?: string[];
  reviewEvidencePath?: string;
  changeIdentity?: ChangeIdentity;
  /** @deprecated Read-only compatibility with 0.1 task records. */
  diffHash?: string;
  reviewerPackage?: unknown;
  learningCandidates?: ReviewerResponse["learningCandidates"];
  reviewAssessment?: ReviewAssessment;
}

export type ContinuationVerificationStatus =
  "not-run" | "current-passed" | "current-incomplete" | "current-failed" | "stale";

export interface GuidedContinuationState {
  changedPaths: string[];
  verification: {
    status: ContinuationVerificationStatus;
    current: boolean;
    summary: string;
  };
  nextAction: string;
}

function policyHash(policy: VerificationCommand[]): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

async function readReviewerEvidence(root: string, relativePath: string): Promise<string> {
  const target = resolveWithin(root, relativePath);
  const canonical = await realpath(target);
  if (!isWithin(await realpath(root), canonical) || !samePath(target, canonical)) {
    throw new Error("Reviewer evidence must not use a symbolic link or leave the repository.");
  }
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 1_000_000) {
      throw new Error(
        "Reviewer evidence must be a regular JSON file no larger than 1000000 bytes.",
      );
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function continuationNextAction(
  record: GuidedRunRecord,
  changedPaths: string[],
  verification: ContinuationVerificationStatus,
): string {
  if (changedPaths.length === 0) {
    return `Make the requested change, then run ${cliCommand("finish")}.`;
  }
  if (verification === "not-run" || verification === "stale") {
    return `Run ${cliCommand("finish")} when the change is ready to check.`;
  }
  if (verification === "current-failed") {
    return `Repair the failing check, then run ${cliCommand("finish")} again.`;
  }
  if (verification === "current-incomplete") {
    return `Resolve the verification gap, then run ${cliCommand("finish")} again.`;
  }
  if (record.status === "review-pending") {
    return `Obtain the required fresh review, then run ${cliCommand("finish")} with its result.`;
  }
  if (record.status === "changes-requested") {
    return `Address the review findings, then run ${cliCommand("finish")} again.`;
  }
  if (record.status === "blocked") {
    return `Resolve the blocked result, then run ${cliCommand("finish")} again.`;
  }
  return `Continue from the recorded result; rerun ${cliCommand("finish")} after any edit.`;
}

export async function inspectGuidedContinuation(
  root: string,
  record: GuidedRunRecord,
  sensitivePaths: string[] = [],
): Promise<GuidedContinuationState> {
  const changedPaths = (
    await changedFiles(root, record.baseline.revision, { strict: true })
  ).filter((changedPath) => changedPath !== record.reviewEvidencePath);
  const currentIdentity = await identifyChange(root, record.baseline.revision, changedPaths);
  const latestChecks = record.verification.at(-1) ?? [];
  let status: ContinuationVerificationStatus;
  let summary: string;
  if (!record.changeIdentity && !record.diffHash) {
    status = "not-run";
    summary = "Not run for the current diff.";
  } else if (
    record.changeIdentity
      ? record.changeIdentity.changeId !== currentIdentity.changeId
      : record.diffHash !==
        createHash("sha256")
          .update(await diffFromRevision(root, record.baseline.revision, sensitivePaths))
          .digest("hex")
  ) {
    status = "stale";
    summary = "Stale because the diff changed afterward.";
  } else if (
    latestChecks.length === 0 ||
    latestChecks.some((result) => result.status === "unavailable")
  ) {
    status = "current-incomplete";
    summary = "Current but incomplete for this diff.";
  } else if (latestChecks.some((result) => result.status !== "passed")) {
    status = "current-failed";
    summary = "Current; at least one affected check did not pass.";
  } else {
    status = "current-passed";
    summary = `Current; ${latestChecks.length} affected check${latestChecks.length === 1 ? "" : "s"} passed.`;
  }
  return {
    changedPaths,
    verification: {
      status,
      current: status.startsWith("current-"),
      summary,
    },
    nextAction: continuationNextAction(record, changedPaths, status),
  };
}

function guidedHandoff(
  record: GuidedRunRecord,
  checks: VerificationResult[],
  review?: ReviewerResponse,
): string {
  const checked = checks.map((result) => {
    const invocation = [result.command.executable, ...result.command.args].join(" ");
    const detail = failureDetail(result);
    return `${result.command.id}: ${result.status} | ${invocation} | cwd ${result.command.cwd} | exit ${result.evidence.exitCode ?? "not started"}${detail ? ` | ${detail}` : ""}`;
  });
  const unavailable = checks.find((result) => result.status === "unavailable");
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
    "CHECKED",
    checked.join("\n") || "Verification incomplete: no applicable approved checks ran.",
    "",
    "REVIEW",
    review
      ? `${review.decision}: ${review.summary}`
      : record.reviewAssessment?.required
        ? `Pending ${record.reviewAssessment.kinds.join("/")} review: ${record.reviewAssessment.reasons.join(" ")}`
        : "Not required for this bounded change.",
    "",
    "LEARNING",
    record.learningCandidates?.length
      ? `${record.learningCandidates.length} documentation candidate${record.learningCandidates.length === 1 ? "" : "s"} identified by review; duplication and ownership still need checking.`
      : record.status === "approved"
        ? "The approved review identified no reusable project-knowledge candidate."
        : "Not assessed; reusable learning requires an approved review of the unchanged diff.",
    "",
    "NEXT",
    record.status === "review-pending"
      ? `Have a fresh reviewer return the strict JSON contract, then run ${cliCommand(`finish --task ${record.id} --review-file <repository-relative-json>`)}.`
      : record.status === "incomplete"
        ? unavailable
          ? `Make the approved check runnable (${unavailable.command.executable} from ${unavailable.command.cwd}: ${unavailable.evidence.stderr || "could not start"}), then rerun ${cliCommand(`finish --task ${record.id}`)}.`
          : "Review the unverified change and add or approve an applicable project check if one exists."
        : checks.some((check) => check.status === "timed-out")
          ? `${TIMEOUT_NEXT} After resolving the cause, rerun ${cliCommand(`finish --task ${record.id}`)}.`
          : "Review the resulting change; apply any learning only after confirmation.",
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
    repository: { root: baseline.root, branch: baseline.branch },
    baseline: { revision: baseline.revision, status: baseline.status },
    context: input.context,
    effectiveAutonomy: input.effectiveAutonomy,
    trustedVerificationPolicy: input.trustedVerificationPolicy,
    verificationPolicyHash: policyHash(input.trustedVerificationPolicy),
    startedAt: new Date().toISOString(),
    calls: [],
    verification: [],
    verificationGaps: [],
    handoff: `Guided task ${input.id} started. Next: ${cliCommand(`finish --task ${input.id}`)}`,
  };
  return partial;
}

export async function finishGuidedRun(input: {
  root: string;
  record: GuidedRunRecord;
  adapter: AgentAdapter;
  reviewAuthorized: boolean;
  reviewFile?: string;
  sensitivePaths?: string[];
  signal?: AbortSignal;
}): Promise<GuidedRunRecord> {
  const { record } = input;
  if (record.mode !== "guided") throw new Error("The task is not a guided run record.");
  const currentRepository = await captureRepositoryBaseline(input.root);
  if (!samePath(currentRepository.root, record.repository.root)) {
    throw new Error("The task belongs to a different repository identity.");
  }
  if (policyHash(record.trustedVerificationPolicy) !== record.verificationPolicyHash) {
    throw new Error("The recorded verification policy snapshot is invalid.");
  }
  const reviewEvidencePath = input.reviewFile
    ? path.relative(input.root, resolveWithin(input.root, input.reviewFile)).replaceAll("\\", "/")
    : undefined;
  if (
    reviewEvidencePath &&
    (!reviewEvidencePath.toLowerCase().startsWith(".noxroot/local/") ||
      !reviewEvidencePath.toLowerCase().endsWith(".json"))
  ) {
    throw new Error("Reviewer evidence must be an untracked JSON file under .noxroot/local/.");
  }
  if (reviewEvidencePath && (await isTrackedPath(input.root, reviewEvidencePath))) {
    throw new Error("Reviewer evidence must not be a tracked repository file.");
  }
  const changedPaths = (
    await changedFiles(input.root, record.baseline.revision, { strict: true })
  ).filter((changedPath) => changedPath !== reviewEvidencePath);
  for (const changedPath of changedPaths) resolveWithin(input.root, changedPath);
  const changeIdentity = await identifyChange(input.root, record.baseline.revision, changedPaths);
  const diff = await diffFromRevision(
    input.root,
    record.baseline.revision,
    input.sensitivePaths ?? [],
    reviewEvidencePath ? [reviewEvidencePath] : [],
  );
  const changedAfterDiff = (
    await changedFiles(input.root, record.baseline.revision, { strict: true })
  ).filter((changedPath) => changedPath !== reviewEvidencePath);
  const identityAfterDiff = await identifyChange(
    input.root,
    record.baseline.revision,
    changedAfterDiff,
  );
  if (identityAfterDiff.changeId !== changeIdentity.changeId) {
    const stale: GuidedRunRecord = {
      ...record,
      status: "incomplete",
      changedPaths,
      changeIdentity,
      verification: [...record.verification, []],
      verificationGaps: ["The repository changed while review evidence was captured."],
      handoff: "",
    };
    stale.handoff = guidedHandoff(stale, []);
    return stale;
  }
  const reviewAssessment = assessReviewNeed(changedPaths, diff, record.task);
  const commands = selectVerification(record.trustedVerificationPolicy, changedPaths);
  const unmatchedChangedPaths = unmatchedVerificationPaths(
    record.trustedVerificationPolicy,
    changedPaths,
  );
  const checks = await executeVerification(input.root, commands, {
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const freshRecord = { ...record };
  delete freshRecord.learningCandidates;
  delete freshRecord.reviewerPackage;
  delete freshRecord.reviewDecision;
  delete freshRecord.finishedAt;
  const next: GuidedRunRecord = {
    ...freshRecord,
    changedPaths,
    unmatchedChangedPaths,
    ...(reviewEvidencePath === undefined ? {} : { reviewEvidencePath }),
    changeIdentity,
    reviewAssessment,
    verification: [...record.verification, checks],
    verificationGaps: [],
  };

  const changedAfterChecks = (
    await changedFiles(input.root, record.baseline.revision, { strict: true })
  ).filter((changedPath) => changedPath !== reviewEvidencePath);
  const identityAfterChecks = await identifyChange(
    input.root,
    record.baseline.revision,
    changedAfterChecks,
  );
  if (identityAfterChecks.changeId !== changeIdentity.changeId) {
    next.status = "incomplete";
    next.verificationGaps = [
      "The repository changed while approved checks ran; their evidence is stale.",
    ];
    next.handoff = guidedHandoff(next, checks);
    return next;
  }

  if (changedPaths.length === 0) {
    next.status = "blocked";
    next.verificationGaps = ["No repository change was detected from the recorded baseline."];
    next.handoff = guidedHandoff(next, checks);
    return next;
  }
  if (checks.length === 0) {
    next.status = "incomplete";
    next.verificationGaps = ["No approved deterministic checks matched the actual change."];
    next.handoff = guidedHandoff(next, checks);
    return next;
  }
  if (unmatchedChangedPaths.length > 0) {
    next.status = "incomplete";
    next.verificationGaps = [`No approved check applies to: ${unmatchedChangedPaths.join(", ")}.`];
    next.handoff = guidedHandoff(next, checks);
    return next;
  }
  if (checks.some((result) => result.status === "unavailable")) {
    next.status = "incomplete";
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

  if (!reviewAssessment.required && !input.reviewFile) {
    next.status = "completed";
    next.finishedAt = new Date().toISOString();
    next.learningCandidates = [];
    next.handoff = guidedHandoff(next, checks);
    return next;
  }

  const reviewerPackage = {
    schemaVersion: 2,
    taskId: record.id,
    changeId: changeIdentity.changeId,
    task: record.task,
    context: record.context,
    changedPaths,
    diff,
    verification: checks,
    reviewAssessment,
    responseContract: {
      schemaVersion: 2,
      taskId: record.id,
      changeId: changeIdentity.changeId,
      decision: "approved | changes-requested | blocked",
      summary: "short factual summary",
      findings: ["severity, optional path, evidence, requiredOutcome"],
      learningCandidates: [],
    },
  };
  next.reviewerPackage = reviewerPackage;
  let reviewResult: AgentResult | undefined;
  if (input.reviewFile) {
    const source = await readReviewerEvidence(input.root, input.reviewFile);
    const review = parseReviewerResponse(source, {
      taskId: record.id,
      changeId: changeIdentity.changeId,
    });
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
          output: "",
          diagnostics: "Rejected reviewer evidence was not retained.",
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
  const changedAfterReview = (
    await changedFiles(input.root, record.baseline.revision, { strict: true })
  ).filter((changedPath) => changedPath !== reviewEvidencePath);
  const identityAfterReview = await identifyChange(
    input.root,
    record.baseline.revision,
    changedAfterReview,
  );
  if (identityAfterReview.changeId !== changeIdentity.changeId) {
    next.status = "blocked";
    next.verificationGaps = [
      "The repository changed during review; verification and the reviewer decision are stale.",
    ];
    next.learningCandidates = [];
    next.handoff = guidedHandoff(next, checks);
    return next;
  }
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
