import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewerResponse } from "../adapters/agents.js";
import { loadConfig } from "../config/load.js";
import type { RunRecord } from "../orchestration/run.js";
import { resolveWithin } from "../security/paths.js";

export type LearningKind = "knowledge" | "decision" | "procedure" | "verification";

export interface LearningProposal {
  id: string;
  signature: string;
  destination: string;
  kind: LearningKind;
  evidence: string[];
  expectedFutureValue: string;
  duplication: "not-found" | "already-covered";
  conflict: "none" | "outside-owned-knowledge" | "existing-signature-conflict";
  content: string;
  executableDestination: string;
}

export interface LearnResult {
  taskId: string;
  proposals: LearningProposal[];
  rejected: Array<{ reason: string; destination: string }>;
  message?: string;
}

interface Candidate {
  kind: LearningKind;
  destination: string;
  evidence: string[];
  expectedFutureValue: string;
  content: string;
  executableDestination: string;
}

const KNOWLEDGE_ROOT = ".noxroot/knowledge/";
const DEFAULT_DOCUMENT_LIMIT = 24_000;
const MAX_CORPUS_BYTES = 1_000_000;

function boundedLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function signature(candidate: Candidate): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: candidate.kind,
        destination: candidate.destination.toLowerCase(),
        evidence: candidate.evidence.map(normalize).sort(),
        content: normalize(candidate.content),
      }),
    )
    .digest("hex")
    .slice(0, 20);
}

function ownedDestination(destination: string): string | undefined {
  const normalized = destination.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized.startsWith(KNOWLEDGE_ROOT) || !normalized.endsWith(".md")) return undefined;
  if (normalized.includes("../") || normalized === `${KNOWLEDGE_ROOT}INDEX.md`) return undefined;
  return normalized;
}

async function knowledgeCorpus(root: string, documentLimit: number): Promise<string> {
  const directory = path.join(root, ".noxroot", "knowledge");
  try {
    const files = (await readdir(directory)).filter((file) => file.endsWith(".md")).sort();
    const sections: string[] = [];
    let bytes = 0;
    for (const file of files) {
      const absolute = path.join(directory, file);
      const size = (await stat(absolute)).size;
      if (size > documentLimit || bytes + size > MAX_CORPUS_BYTES) continue;
      sections.push(`\n<!-- ${file} -->\n${await readFile(absolute, "utf8")}`);
      bytes += size;
    }
    return sections.join("");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function structuredCandidates(run: RunRecord): ReviewerResponse["learningCandidates"] {
  const direct = (
    run as RunRecord & {
      learningCandidates?: ReviewerResponse["learningCandidates"];
    }
  ).learningCandidates;
  return [
    ...(direct ?? []),
    ...run.calls.flatMap((call) => call.result.review?.learningCandidates ?? []),
  ];
}

function fromReviewer(
  value: ReviewerResponse["learningCandidates"][number],
): Candidate | undefined {
  if (value.kind === "none") return undefined;
  return {
    kind: value.kind,
    destination: value.destination,
    evidence: [...new Set(value.evidence.map(boundedLine))].filter(Boolean).sort().slice(0, 20),
    expectedFutureValue: boundedLine(value.expectedValue),
    content: value.content.trim().slice(0, 4_000),
    executableDestination: boundedLine(value.whyNotExecutable),
  };
}

function proposalContent(
  candidate: Candidate,
  digest: string,
  taskId: string,
  confirmedOn: string,
): string {
  const heading =
    candidate.kind === "verification"
      ? "Verification candidate"
      : `${candidate.kind[0]?.toUpperCase()}${candidate.kind.slice(1)} candidate`;
  return `<!-- noxroot-learning:${digest} -->
## ${heading}

Last confirmed: ${confirmedOn}
Source task: ${taskId}
- Evidence: ${candidate.evidence.join("; ")}
- Expected future value: ${candidate.expectedFutureValue}
- Executable destination: ${candidate.executableDestination}

${candidate.content.trim()}
`;
}

export async function proposeLearnings(root: string, run: RunRecord): Promise<LearnResult> {
  const candidates = structuredCandidates(run)
    .map(fromReviewer)
    .filter((candidate): candidate is Candidate => candidate !== undefined);
  const config = await loadConfig(root);
  const documentLimit = config?.context.documentWarningBytes ?? DEFAULT_DOCUMENT_LIMIT;
  const corpus = await knowledgeCorpus(root, documentLimit);
  const confirmedAt = (run as RunRecord & { finishedAt?: unknown }).finishedAt;
  const confirmedOn =
    typeof confirmedAt === "string" && /^\d{4}-\d{2}-\d{2}/.test(confirmedAt)
      ? confirmedAt.slice(0, 10)
      : new Date().toISOString().slice(0, 10);
  const proposals: LearningProposal[] = [];
  const rejected: LearnResult["rejected"] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const destination = ownedDestination(candidate.destination);
    if (!destination) {
      rejected.push({
        destination: candidate.destination,
        reason: "Learning may update only a Noxroot-owned Markdown file under .noxroot/knowledge/.",
      });
      continue;
    }
    if (candidate.evidence.length === 0 || !candidate.content.trim()) {
      rejected.push({ destination, reason: "A proposal requires evidence and concise content." });
      continue;
    }
    const normalized = { ...candidate, destination };
    const digest = signature(normalized);
    if (seen.has(digest)) continue;
    seen.add(digest);
    const marker = `<!-- noxroot-learning:${digest} -->`;
    if (corpus.includes(marker)) continue;
    const evidenceLine = candidate.evidence.join("; ");
    const conflictingMarker = corpus.includes(`- Evidence: ${evidenceLine}`);
    const content = proposalContent(normalized, digest, run.id, confirmedOn);
    const target = resolveWithin(root, destination);
    const existing = await existingOr(target, "# Validated learnings\n\n");
    const projected = `${existing.trimEnd()}\n\n${content.trim()}\n`;
    if (Buffer.byteLength(projected) > documentLimit) {
      rejected.push({
        destination,
        reason: `The destination would exceed ${documentLimit} bytes. Consolidate or supersede existing knowledge before adding another entry.`,
      });
      continue;
    }
    proposals.push({
      id: `${candidate.kind}-${digest}`,
      signature: digest,
      destination,
      kind: candidate.kind,
      evidence: candidate.evidence,
      expectedFutureValue: candidate.expectedFutureValue,
      duplication: "not-found",
      conflict: conflictingMarker ? "existing-signature-conflict" : "none",
      content,
      executableDestination: candidate.executableDestination,
    });
  }
  return {
    taskId: run.id,
    proposals,
    rejected,
    ...(proposals.length === 0 ? { message: "No durable learning identified" } : {}),
  };
}

async function existingOr(target: string, fallback: string): Promise<string> {
  try {
    await stat(target);
    return await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function applyLearning(root: string, proposal: LearningProposal): Promise<string[]> {
  if (proposal.conflict !== "none" || proposal.duplication !== "not-found") {
    throw new Error(`Learning proposal ${proposal.id} is not safely applicable.`);
  }
  const target = resolveWithin(root, proposal.destination);
  await mkdir(path.dirname(target), { recursive: true });
  const existing = await existingOr(target, "# Validated learnings\n\n");
  if (existing.includes(`<!-- noxroot-learning:${proposal.signature} -->`)) {
    return [proposal.destination];
  }
  const indexPath = resolveWithin(root, ".noxroot/knowledge/INDEX.md");
  const index = await existingOr(indexPath, "# Noxroot knowledge index\n\n");
  const basename = path.posix.basename(proposal.destination);
  const indexNext = index.includes(`](${basename})`)
    ? index
    : `${index.trimEnd()}\n\n- [Validated learnings](${basename}) — confirmed, deduplicated durable lessons.\n`;
  const targetNext = `${existing.trimEnd()}\n\n${proposal.content.trim()}\n`;
  const config = await loadConfig(root);
  const documentLimit = config?.context.documentWarningBytes ?? DEFAULT_DOCUMENT_LIMIT;
  if (Buffer.byteLength(targetNext) > documentLimit) {
    throw new Error(
      `Learning destination ${proposal.destination} would exceed ${documentLimit} bytes; consolidate it before applying another entry.`,
    );
  }
  const targetTemp = `${target}.tmp-${process.pid}`;
  const indexTemp = `${indexPath}.tmp-${process.pid}`;
  await writeFile(targetTemp, targetNext, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await writeFile(indexTemp, indexNext, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(targetTemp, target);
  await rename(indexTemp, indexPath);
  return [proposal.destination, ".noxroot/knowledge/INDEX.md"];
}
