import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunRecord } from "../orchestration/run.js";
import { resolveWithin } from "../security/paths.js";

export interface LearningProposal {
  id: string;
  destination: string;
  kind: "verification-improvement";
  evidence: string[];
  duplication: "not-found" | "already-covered";
  expectedValue: string;
  content: string;
}

export interface LearnResult {
  taskId: string;
  proposals: LearningProposal[];
  message?: string;
}

async function currentKnowledge(root: string): Promise<string> {
  try {
    return await readFile(path.join(root, ".noxroot", "knowledge", "learnings.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function proposeLearnings(root: string, run: RunRecord): Promise<LearnResult> {
  if (run.verificationGaps.length === 0) {
    return { taskId: run.id, proposals: [], message: "No durable learning identified" };
  }
  const existing = await currentKnowledge(root);
  const evidence = [...new Set(run.verificationGaps)].sort();
  const signature = evidence.join(" | ");
  const duplication = existing.includes(signature) ? "already-covered" : "not-found";
  if (duplication === "already-covered") {
    return { taskId: run.id, proposals: [], message: "No durable learning identified" };
  }
  return {
    taskId: run.id,
    proposals: [
      {
        id: `verification-gap-${run.id}`,
        destination: ".noxroot/knowledge/learnings.md",
        kind: "verification-improvement",
        evidence,
        duplication,
        expectedValue:
          "Makes a recurring verification limitation visible without authorizing a new command.",
        content: `## Verification policy gap (${run.id})\n\n- Evidence: ${signature}\n- Action: project owner should confirm whether an executable guardrail is justified.\n`,
      },
    ],
  };
}

export async function applyLearning(root: string, proposal: LearningProposal): Promise<string> {
  const target = resolveWithin(root, proposal.destination);
  await mkdir(path.dirname(target), { recursive: true });
  let existing = "# Validated learnings\n\n";
  try {
    await stat(target);
    existing = await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing.includes(proposal.content)) return proposal.destination;
  const temp = `${target}.tmp-${process.pid}`;
  await writeFile(temp, `${existing.trimEnd()}\n\n${proposal.content.trim()}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temp, target);
  return proposal.destination;
}
