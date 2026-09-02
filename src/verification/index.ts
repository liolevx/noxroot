import path from "node:path";
import { loadVerification } from "../config/load.js";
import type { VerificationCommand, VerificationResult } from "../model.js";
import { runProcess, type ProcessRequest } from "../adapters/process.js";

function matches(pattern: string, changedPath: string): boolean {
  const normalized = changedPath.replaceAll("\\", "/");
  if (pattern === "**/*" || pattern === "**") return true;
  if (pattern.endsWith("/**")) return normalized.startsWith(pattern.slice(0, -3));
  if (pattern.startsWith("**/*.")) return normalized.endsWith(pattern.slice(4));
  if (!pattern.includes("*")) return normalized === pattern;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${escaped}$`).test(normalized);
}

export async function planVerification(
  root: string,
  changedPaths: string[] = [],
): Promise<VerificationCommand[]> {
  const policy = await loadVerification(root);
  if (!policy) return [];
  return policy.commands
    .filter(
      (command) =>
        changedPaths.length === 0 ||
        command.appliesTo.some((pattern) =>
          changedPaths.some((changed) => matches(pattern, changed)),
        ),
    )
    .map((command) => ({ ...command }));
}

export async function executeVerification(
  root: string,
  commands: VerificationCommand[],
  options: {
    signal?: AbortSignal;
    outputLimitBytes?: number;
    runner?: (request: ProcessRequest) => Promise<Awaited<ReturnType<typeof runProcess>>>;
  } = {},
): Promise<VerificationResult[]> {
  const runner = options.runner ?? runProcess;
  const results: VerificationResult[] = [];
  for (const command of commands) {
    const evidence = await runner({
      executable: command.executable,
      args: command.args,
      cwd: path.resolve(root, command.cwd),
      repositoryRoot: root,
      timeoutMs: command.timeoutMs,
      ...(options.outputLimitBytes === undefined
        ? {}
        : { outputLimitBytes: options.outputLimitBytes }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    results.push({
      command,
      evidence,
      status: evidence.timedOut ? "timed-out" : evidence.exitCode === 0 ? "passed" : "failed",
    });
    if (evidence.exitCode !== 0) break;
  }
  return results;
}

export async function changedFiles(root: string): Promise<string[]> {
  try {
    const result = await runProcess({
      executable: "git",
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      cwd: root,
      repositoryRoot: root,
      timeoutMs: 10_000,
      outputLimitBytes: 1_000_000,
    });
    if (result.exitCode !== 0) return [];
    const parts = result.stdout.split("\0").filter(Boolean);
    const files: string[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const entry = parts[index];
      if (!entry || entry.length < 4) continue;
      const status = entry.slice(0, 2);
      files.push(entry.slice(3).replaceAll("\\", "/"));
      if ((status.includes("R") || status.includes("C")) && parts[index + 1]) index += 1;
    }
    return [...new Set(files)].sort();
  } catch {
    return [];
  }
}
