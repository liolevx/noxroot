import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewerResponse } from "../adapters/agents.js";
import { identifyChange, type ChangeIdentity } from "../adapters/vcs.js";
import { loadConfig } from "../config/load.js";
import type { RunRecord } from "../orchestration/run.js";
import { resolveWithin } from "../security/paths.js";
import { changedFiles } from "../verification/index.js";

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
  const normalized = path.posix.normalize(destination.replaceAll("\\", "/"));
  if (!normalized.startsWith(KNOWLEDGE_ROOT) || !normalized.endsWith(".md")) return undefined;
  if (normalized.toLowerCase() === `${KNOWLEDGE_ROOT}index.md`) return undefined;
  return normalized;
}

async function checkKnowledgePath(root: string, relative: string): Promise<string> {
  const target = resolveWithin(root, relative);
  let current = path.resolve(root);
  for (const segment of path.relative(current, target).split(path.sep)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("Learning cannot follow a symbolic link in owned knowledge.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}

async function knowledgeCorpus(
  root: string,
  documentLimit: number,
): Promise<{
  text: string;
  bytes: number;
  sizes: Map<string, number>;
}> {
  const directory = path.join(root, ".noxroot", "knowledge");
  await checkKnowledgePath(root, KNOWLEDGE_ROOT);
  const sections: string[] = [];
  const sizes = new Map<string, number>();
  let bytes = 0;
  let loadedBytes = 0;
  let visited = 0;
  const visit = async (folder: string): Promise<void> => {
    const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (++visited > 4096)
        throw new Error(
          "Knowledge corpus inspection limit reached; consolidate before adding learning.",
        );
      const absolute = path.join(folder, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Learning cannot follow a symbolic link in owned knowledge.");
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const size = (await stat(absolute)).size;
        sizes.set(absolute, size);
        bytes += size;
        if (size > documentLimit || loadedBytes + size > MAX_CORPUS_BYTES) continue;
        sections.push(
          `\n<!-- ${path.relative(directory, absolute)} -->\n${await readFile(absolute, "utf8")}`,
        );
        loadedBytes += size;
      }
    }
  };
  try {
    await visit(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { text: sections.join(""), bytes, sizes };
}

function structuredCandidates(run: RunRecord): ReviewerResponse["learningCandidates"] {
  const direct = (
    run as RunRecord & {
      learningCandidates?: ReviewerResponse["learningCandidates"];
    }
  ).learningCandidates;
  return direct ?? [];
}

async function currentApprovedChange(root: string, run: RunRecord): Promise<boolean> {
  const guided = run as RunRecord & {
    mode?: unknown;
    baseline?: { revision?: unknown };
    changeIdentity?: ChangeIdentity;
    reviewEvidencePath?: string;
  };
  if (
    run.status !== "approved" ||
    guided.mode !== "guided" ||
    typeof guided.baseline?.revision !== "string" ||
    !guided.changeIdentity
  ) {
    return false;
  }
  const changedPaths = (await changedFiles(root, guided.baseline.revision)).filter(
    (changedPath) => changedPath !== guided.reviewEvidencePath,
  );
  const current = await identifyChange(root, guided.baseline.revision, changedPaths);
  return current.changeId === guided.changeIdentity.changeId;
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
  if (!(await currentApprovedChange(root, run))) {
    return {
      taskId: run.id,
      proposals: [],
      rejected: [],
      message: "Learning requires an approved review of the current unchanged diff",
    };
  }
  const candidates = structuredCandidates(run)
    .map(fromReviewer)
    .filter((candidate): candidate is Candidate => candidate !== undefined);
  if (candidates.length === 0) {
    return {
      taskId: run.id,
      proposals: [],
      rejected: [],
      message: "No durable learning identified",
    };
  }
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
    if (corpus.text.includes(marker)) continue;
    const evidenceLine = candidate.evidence.join("; ");
    const conflictingMarker = corpus.text.includes(`- Evidence: ${evidenceLine}`);
    const content = proposalContent(normalized, digest, run.id, confirmedOn);
    const target = await checkKnowledgePath(root, destination);
    const existing = await existingOr(target, "# Validated learnings\n\n");
    const projected = `${existing.trimEnd()}\n\n${content.trim()}\n`;
    if (
      corpus.bytes - (corpus.sizes.get(target) ?? 0) + Buffer.byteLength(projected) >
      MAX_CORPUS_BYTES
    ) {
      rejected.push({
        destination,
        reason: `The knowledge corpus would exceed ${MAX_CORPUS_BYTES} bytes. Consolidate existing knowledge before adding another entry.`,
      });
      continue;
    }
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
  const destination = ownedDestination(proposal.destination);
  if (!destination) {
    throw new Error("Learning may update only Noxroot-owned Markdown under .noxroot/knowledge/.");
  }
  if (proposal.conflict !== "none" || proposal.duplication !== "not-found") {
    throw new Error(`Learning proposal ${proposal.id} is not safely applicable.`);
  }
  const target = await checkKnowledgePath(root, destination);
  const existing = await existingOr(target, "# Validated learnings\n\n");
  if (existing.includes(`<!-- noxroot-learning:${proposal.signature} -->`)) {
    return [proposal.destination];
  }
  const indexPath = await checkKnowledgePath(root, ".noxroot/knowledge/INDEX.md");
  const index = await existingOr(indexPath, "# Noxroot knowledge index\n\n");
  const basename = destination.slice(KNOWLEDGE_ROOT.length);
  const indexNext = index.includes(`](${basename})`)
    ? index
    : `${index.trimEnd()}\n\n- [Validated learnings](${basename}) — confirmed, deduplicated durable lessons.\n`;
  const targetNext = `${existing.trimEnd()}\n\n${proposal.content.trim()}\n`;
  const config = await loadConfig(root);
  const documentLimit = config?.context.documentWarningBytes ?? DEFAULT_DOCUMENT_LIMIT;
  const corpus = await knowledgeCorpus(root, documentLimit);
  const projectedBytes =
    corpus.bytes -
    (corpus.sizes.get(target) ?? 0) -
    (corpus.sizes.get(indexPath) ?? 0) +
    Buffer.byteLength(targetNext) +
    Buffer.byteLength(indexNext);
  if (projectedBytes > MAX_CORPUS_BYTES) {
    throw new Error(
      `Knowledge corpus would exceed ${MAX_CORPUS_BYTES} bytes; consolidate it before applying another entry.`,
    );
  }
  if (Buffer.byteLength(indexNext) > documentLimit) {
    throw new Error(
      `Knowledge index would exceed ${documentLimit} bytes; consolidate it before applying another entry.`,
    );
  }
  if (Buffer.byteLength(targetNext) > documentLimit) {
    throw new Error(
      `Learning destination ${proposal.destination} would exceed ${documentLimit} bytes; consolidate it before applying another entry.`,
    );
  }
  const targetTemp = `${target}.tmp-${process.pid}`;
  const indexTemp = `${indexPath}.tmp-${process.pid}`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(targetTemp, targetNext, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await writeFile(indexTemp, indexNext, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(targetTemp, target);
  await rename(indexTemp, indexPath);
  return [proposal.destination, ".noxroot/knowledge/INDEX.md"];
}
