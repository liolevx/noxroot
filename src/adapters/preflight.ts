import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import type { VerificationCommand } from "../model.js";
import { runProcess, type ProcessRequest } from "./process.js";

export interface PreflightCheck {
  id: "adapter" | "arguments" | "repository-write" | "git" | "verification" | "health";
  status: "passed" | "failed" | "skipped";
  detail: string;
}

export interface AgentPreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  diagnostics: string[];
  retry: string;
}

interface HealthCheck {
  executable: string;
  args: string[];
  timeoutMs: number;
}

function pathExtensions(): string[] {
  if (process.platform !== "win32") return [""];
  return (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((value) => value.toLowerCase());
}

async function executableFile(candidate: string): Promise<boolean> {
  try {
    const value = await stat(candidate);
    if (!value.isFile()) return false;
    await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveExecutable(
  executable: string,
  cwd: string,
): Promise<string | undefined> {
  if (!executable.trim() || executable.includes("\0")) return undefined;
  const containsSeparator = executable.includes("/") || executable.includes("\\");
  const baseCandidates = path.isAbsolute(executable)
    ? [executable]
    : containsSeparator
      ? [path.resolve(cwd, executable)]
      : (process.env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((entry) => path.join(entry, executable));
  const extensions = pathExtensions();
  for (const candidate of baseCandidates) {
    const hasExtension = process.platform !== "win32" || Boolean(path.extname(candidate));
    for (const suffix of hasExtension ? [""] : extensions) {
      const resolved = `${candidate}${suffix}`;
      if (await executableFile(resolved)) return resolved;
    }
  }
  return undefined;
}

export async function preflightCommandAdapter(input: {
  executable: string;
  args: string[];
  cwd: string;
  repositoryRoot: string;
  verification: VerificationCommand[];
  health?: HealthCheck;
  runner?: (request: ProcessRequest) => Promise<Awaited<ReturnType<typeof runProcess>>>;
}): Promise<AgentPreflightResult> {
  const checks: PreflightCheck[] = [];
  const diagnostics: string[] = [];
  const runner = input.runner ?? runProcess;
  const adapterExecutable = await resolveExecutable(input.executable, input.cwd);
  checks.push({
    id: "adapter",
    status: adapterExecutable ? "passed" : "failed",
    detail: adapterExecutable
      ? `Configured adapter executable found: ${input.executable}`
      : `Configured adapter executable was not found: ${input.executable}`,
  });
  const validArguments = input.args.every((argument) => !argument.includes("\0"));
  checks.push({
    id: "arguments",
    status: validArguments ? "passed" : "failed",
    detail: validArguments
      ? "Configured arguments are literal strings."
      : "A configured adapter argument contains a null byte.",
  });
  try {
    await access(input.repositoryRoot, constants.W_OK);
    checks.push({
      id: "repository-write",
      status: "passed",
      detail: "Repository root is writable for implementation.",
    });
  } catch (error) {
    checks.push({
      id: "repository-write",
      status: "failed",
      detail: "Repository root is not writable for implementation.",
    });
    diagnostics.push((error as Error).message);
  }

  const gitExecutable = await resolveExecutable("git", input.cwd);
  if (!gitExecutable) {
    checks.push({ id: "git", status: "failed", detail: "Git executable was not found." });
  } else {
    const git = await runner({
      executable: gitExecutable,
      args: ["rev-parse", "--verify", "HEAD"],
      cwd: input.cwd,
      repositoryRoot: input.repositoryRoot,
      timeoutMs: 10_000,
      outputLimitBytes: 8_000,
    });
    checks.push({
      id: "git",
      status: git.exitCode === 0 ? "passed" : "failed",
      detail:
        git.exitCode === 0
          ? "Git repository and committed baseline are available."
          : "A Git repository with a committed baseline is required for delegated isolation.",
    });
    if (git.exitCode !== 0 && git.stderr.trim()) diagnostics.push(git.stderr.trim());
  }

  const missingVerification: string[] = [];
  for (const command of input.verification) {
    if (!(await resolveExecutable(command.executable, path.resolve(input.cwd, command.cwd)))) {
      missingVerification.push(`${command.id} (${command.executable})`);
    }
  }
  checks.push({
    id: "verification",
    status: missingVerification.length > 0 ? "failed" : "passed",
    detail:
      missingVerification.length > 0
        ? `Approved verification executables were not found: ${missingVerification.join(", ")}`
        : `${input.verification.length} approved verification executable(s) are available.`,
  });

  if (input.health) {
    const healthExecutable = await resolveExecutable(input.health.executable, input.cwd);
    if (!healthExecutable) {
      checks.push({
        id: "health",
        status: "failed",
        detail: `Configured health executable was not found: ${input.health.executable}`,
      });
    } else {
      const health = await runner({
        executable: healthExecutable,
        args: input.health.args,
        cwd: input.cwd,
        repositoryRoot: input.repositoryRoot,
        timeoutMs: input.health.timeoutMs,
        outputLimitBytes: 16_000,
      });
      checks.push({
        id: "health",
        status: health.exitCode === 0 ? "passed" : "failed",
        detail:
          health.exitCode === 0
            ? "Explicitly configured health check passed."
            : `Explicitly configured health check exited with ${health.exitCode ?? health.signal ?? "an error"}.`,
      });
      if (health.exitCode !== 0 && health.stderr.trim()) diagnostics.push(health.stderr.trim());
    }
  } else {
    checks.push({
      id: "health",
      status: "skipped",
      detail: "No health or authentication command was explicitly configured; none was guessed.",
    });
  }

  return {
    ok: checks.every((check) => check.status !== "failed"),
    checks,
    diagnostics,
    retry:
      "Fix the failed prerequisite, then rerun the same noxroot run command. No worktree was created.",
  };
}
