import path from "node:path";
import type { NoxrootConfig } from "../config/schema.js";
import { runProcess, type ProcessRequest } from "./process.js";

export type AgentRole = "worker" | "reviewer" | "repair";

export interface AgentRequest {
  role: AgentRole;
  package: unknown;
  cwd: string;
  repositoryRoot: string;
  signal?: AbortSignal;
}

export interface AgentResult {
  invoked: boolean;
  status: "completed" | "failed" | "manual";
  summary: string;
  output: string;
  exitCode: number | null;
  reviewDecision?: "approved" | "changes-requested" | "blocked";
}

export interface AgentAdapter {
  id: string;
  mode: "manual" | "command";
  availability(): Promise<{ available: boolean; reason: string }>;
  invoke(request: AgentRequest): Promise<AgentResult>;
}

export class ManualAgentAdapter implements AgentAdapter {
  readonly id = "manual";
  readonly mode = "manual" as const;

  async availability(): Promise<{ available: boolean; reason: string }> {
    return {
      available: true,
      reason: "Produces a portable task package without invoking an agent.",
    };
  }

  async invoke(request: AgentRequest): Promise<AgentResult> {
    return {
      invoked: false,
      status: "manual",
      summary: `Manual ${request.role} package generated; no agent was invoked.`,
      output: `${JSON.stringify(request.package, null, 2)}\n`,
      exitCode: null,
    };
  }
}

function decisionFromOutput(output: string): AgentResult["reviewDecision"] {
  try {
    const parsed = JSON.parse(output) as { decision?: unknown };
    if (parsed.decision === "approved") return "approved";
    if (parsed.decision === "changes-requested") return "changes-requested";
    if (parsed.decision === "blocked") return "blocked";
  } catch {
    const lower = output.toLowerCase();
    if (lower.includes("changes requested")) return "changes-requested";
    if (lower.includes("approved")) return "approved";
    if (lower.includes("blocked") || lower.includes("unverifiable")) return "blocked";
  }
  return undefined;
}

export class CommandAgentAdapter implements AgentAdapter {
  readonly mode = "command" as const;

  constructor(
    readonly id: string,
    private readonly executable: string,
    private readonly args: string[],
    private readonly timeoutMs: number,
    private readonly outputLimitBytes: number,
    private readonly runner: (
      request: ProcessRequest,
    ) => Promise<Awaited<ReturnType<typeof runProcess>>> = runProcess,
  ) {}

  async availability(): Promise<{ available: boolean; reason: string }> {
    return {
      available: true,
      reason: "Availability is confirmed only when the configured executable starts successfully.",
    };
  }

  async invoke(request: AgentRequest): Promise<AgentResult> {
    try {
      const evidence = await this.runner({
        executable: this.executable,
        args: this.args,
        cwd: path.resolve(request.cwd),
        repositoryRoot: request.repositoryRoot,
        timeoutMs: this.timeoutMs,
        outputLimitBytes: this.outputLimitBytes,
        input: `${JSON.stringify({ role: request.role, taskPackage: request.package })}\n`,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const combined = [evidence.stdout, evidence.stderr].filter(Boolean).join("\n");
      const result: AgentResult = {
        invoked: true,
        status: evidence.exitCode === 0 ? "completed" : "failed",
        summary:
          evidence.exitCode === 0
            ? `${request.role} command completed.`
            : `${request.role} command exited with ${evidence.exitCode ?? evidence.signal ?? "an error"}.`,
        output: combined,
        exitCode: evidence.exitCode,
      };
      if (request.role === "reviewer") {
        const decision = decisionFromOutput(evidence.stdout);
        if (decision !== undefined) result.reviewDecision = decision;
      }
      return result;
    } catch (error) {
      return {
        invoked: true,
        status: "failed",
        summary: `${request.role} command could not start: ${(error as Error).message}`,
        output: "",
        exitCode: null,
      };
    }
  }
}

export function configuredAgent(config: NoxrootConfig | undefined): AgentAdapter {
  if (!config) return new ManualAgentAdapter();
  const id = config.agents.default;
  const adapter = config.agents.adapters[id];
  if (!adapter) throw new Error(`Configured default agent adapter “${id}” does not exist.`);
  if (adapter.type === "manual") return new ManualAgentAdapter();
  return new CommandAgentAdapter(
    id,
    adapter.executable,
    adapter.args,
    adapter.timeoutMs,
    config.budgets.outputBytes,
  );
}
