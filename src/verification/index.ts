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

export function selectVerification(
  commands: VerificationCommand[],
  changedPaths: string[],
): VerificationCommand[] {
  if (changedPaths.length === 0) return [];
  return commands.filter((command) =>
    command.appliesTo.some((pattern) =>
      changedPaths.some((changedPath) => matches(pattern, changedPath)),
    ),
  );
}

export async function planVerification(
  root: string,
  changedPaths: string[] = [],
): Promise<VerificationCommand[]> {
  const policy = await loadVerification(root);
  if (!policy) return [];
  const commands = policy.commands.map((command) => ({ ...command }));
  return changedPaths.length === 0 ? commands : selectVerification(commands, changedPaths);
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
    let evidence;
    try {
      evidence = await runner({
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
    } catch (error) {
      const timestamp = new Date().toISOString();
      results.push({
        command,
        status: "unavailable",
        evidence: {
          executable: command.executable,
          args: command.args,
          cwd: path.resolve(root, command.cwd),
          startedAt: timestamp,
          endedAt: timestamp,
          durationMs: 0,
          exitCode: null,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: (error as Error).message,
          outputTruncated: false,
        },
      });
      break;
    }
    results.push({
      command,
      evidence,
      status: evidence.timedOut ? "timed-out" : evidence.exitCode === 0 ? "passed" : "failed",
    });
    if (evidence.exitCode !== 0) break;
  }
  return results;
}

export async function changedFiles(root: string, baseRevision?: string): Promise<string[]> {
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
    if (baseRevision) {
      const committed = await runProcess({
        executable: "git",
        args: ["diff", "--name-only", "-z", baseRevision, "HEAD", "--"],
        cwd: root,
        repositoryRoot: root,
        timeoutMs: 10_000,
        outputLimitBytes: 1_000_000,
      });
      if (committed.exitCode === 0) {
        files.push(...committed.stdout.split("\0").filter(Boolean));
      }
    }
    return [...new Set(files.map((file) => file.replaceAll("\\", "/")))].sort();
  } catch {
    return [];
  }
}
