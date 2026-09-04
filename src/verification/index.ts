import path from "node:path";
import { loadConfig, loadVerification } from "../config/load.js";
import { inspectRepositoryAdoption } from "../detection/adoption.js";
import { scanRepository } from "../detection/scan.js";
import type { VerificationCommand, VerificationResult } from "../model.js";
import { runProcess, type ProcessRequest } from "../adapters/process.js";

export function matchesVerificationPath(pattern: string, changedPath: string): boolean {
  const normalized = changedPath.replaceAll("\\", "/");
  if (pattern === "**/*" || pattern === "**") return true;
  if (pattern.endsWith("/**")) {
    const directory = pattern.slice(0, -3).replace(/\/$/, "");
    return normalized === directory || normalized.startsWith(`${directory}/`);
  }
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
      changedPaths.some((changedPath) => matchesVerificationPath(pattern, changedPath)),
    ),
  );
}

export function unmatchedVerificationPaths(
  commands: VerificationCommand[],
  changedPaths: string[],
): string[] {
  return changedPaths.filter(
    (changedPath) =>
      !commands.some((command) =>
        command.appliesTo.some((pattern) => matchesVerificationPath(pattern, changedPath)),
      ),
  );
}

export async function planVerification(
  root: string,
  changedPaths: string[] = [],
): Promise<VerificationCommand[]> {
  const policy = await loadVerification(root);
  let commands: VerificationCommand[];
  if (policy) {
    commands = policy.commands.map((command) => ({ ...command }));
  } else {
    const config = await loadConfig(root);
    if (!config?.modules.includes("verification")) return [];
    const profile = await scanRepository(root, { sensitivePaths: config.sensitivePaths });
    const adoption = await inspectRepositoryAdoption(profile);
    commands = adoption.verificationWrappers.map((command) => ({
      id: command.id,
      executable: command.executable,
      args: command.args,
      cwd: command.cwd,
      timeoutMs: 120_000,
      appliesTo: command.appliesTo,
    }));
  }
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

export async function changedFiles(
  root: string,
  baseRevision?: string,
  options: { strict?: boolean } = {},
): Promise<string[]> {
  try {
    const result = await runProcess({
      executable: "git",
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      cwd: root,
      repositoryRoot: root,
      timeoutMs: 10_000,
      outputLimitBytes: 1_000_000,
    });
    if (result.exitCode !== 0 || result.outputTruncated) {
      if (options.strict) throw new Error("Complete changed-path metadata could not be captured.");
      return [];
    }
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
      if (committed.exitCode === 0 && !committed.outputTruncated) {
        files.push(...committed.stdout.split("\0").filter(Boolean));
      } else if (options.strict) {
        throw new Error("Complete committed-path metadata could not be captured.");
      }
    }
    return [...new Set(files.map((file) => file.replaceAll("\\", "/")))].sort();
  } catch (error) {
    if (options.strict) throw error;
    return [];
  }
}
