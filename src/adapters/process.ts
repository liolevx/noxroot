import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ProcessEvidence } from "../model.js";
import { isWithin } from "../security/paths.js";

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  repositoryRoot: string;
  timeoutMs: number;
  outputLimitBytes?: number;
  input?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

const ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "LANG",
  "LC_ALL",
  "CI",
  "NO_COLOR",
];

function safeEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) environment[name] = value;
  return environment;
}

const COREPACK_COMMANDS = new Set(["pnpm", "pnpx", "yarn", "yarnpkg"]);

export function resolvePlatformCommand(
  executable: string,
  args: string[],
): { executable: string; args: string[] } {
  const normalized = executable.toLowerCase();
  if (process.platform === "win32" && ["npm", "npx"].includes(normalized)) {
    const cliName = normalized === "npm" ? "npm-cli.js" : "npx-cli.js";
    const configured = process.env.npm_execpath;
    const installed = path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      cliName,
    );
    const cli = configured && existsSync(configured) ? configured : installed;
    if (!existsSync(cli)) {
      throw new Error(
        `Cannot resolve the Windows ${executable} JavaScript CLI without a shell; configure Node plus an explicit CLI path.`,
      );
    }
    return { executable: process.execPath, args: [cli, ...args] };
  }
  if (process.platform === "win32" && COREPACK_COMMANDS.has(normalized)) {
    const cli = path.join(
      path.dirname(process.execPath),
      "node_modules",
      "corepack",
      "dist",
      `${normalized}.js`,
    );
    if (!existsSync(cli)) {
      throw new Error(
        `Cannot resolve the Windows ${executable} JavaScript CLI without a shell; install or enable Corepack for this Node.js runtime.`,
      );
    }
    return { executable: process.execPath, args: [cli, ...args] };
  }
  return { executable, args };
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number; truncated: boolean },
  limit: number,
): void {
  chunks.push(chunk);
  state.bytes += chunk.byteLength;
  while (state.bytes > limit) {
    state.truncated = true;
    const first = chunks[0]!;
    const excess = state.bytes - limit;
    if (first.byteLength <= excess) {
      chunks.shift();
      state.bytes -= first.byteLength;
    } else {
      chunks[0] = first.subarray(excess);
      state.bytes -= excess;
    }
  }
}

function decodeTail(chunks: Buffer[]): string {
  const buffer = Buffer.concat(chunks);
  let start = 0;
  // A byte-capped tail can start inside a UTF-8 character. Drop only the cut prefix/suffix.
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(buffer.subarray(start), { stream: true });
}

export async function runProcess(request: ProcessRequest): Promise<ProcessEvidence> {
  if (request.signal?.aborted) throw new Error("Process cancelled before it started.");
  const cwd = path.resolve(request.cwd);
  if (!isWithin(request.repositoryRoot, cwd)) {
    throw new Error(`Process working directory escapes repository: ${request.cwd}`);
  }
  if (request.executable.trim() === "" || request.executable.includes("\0")) {
    throw new Error("Process executable is empty or invalid.");
  }
  if (request.args.some((argument) => argument.includes("\0"))) {
    throw new Error("Process argument contains a null byte.");
  }

  const outputLimit = request.outputLimitBytes ?? 65_536;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const stdoutState = { bytes: 0, truncated: false };
  const stderrState = { bytes: 0, truncated: false };
  const startedAt = new Date();
  const started = performance.now();
  const command = resolvePlatformCommand(request.executable, request.args);

  return new Promise<ProcessEvidence>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd,
      env: safeEnvironment(request.env),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, request.timeoutMs);
    timeout.unref();

    const abort = (): void => {
      child.kill("SIGTERM");
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) =>
      appendBounded(stdout, chunk, stdoutState, outputLimit),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      appendBounded(stderr, chunk, stderrState, outputLimit),
    );
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
      const endedAt = new Date();
      resolve({
        executable: command.executable,
        args: command.args,
        cwd,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        exitCode,
        signal,
        timedOut,
        stdout: decodeTail(stdout),
        stderr: decodeTail(stderr),
        outputTruncated: stdoutState.truncated || stderrState.truncated,
      });
    });
    if (request.input !== undefined) child.stdin.end(request.input);
    else child.stdin.end();
  });
}
