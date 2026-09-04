import path from "node:path";
import { z } from "zod";
import type { NoxrootConfig } from "../config/schema.js";
import { runProcess, type ProcessRequest } from "./process.js";
import { preflightCommandAdapter, type AgentPreflightResult } from "./preflight.js";
import type { VerificationCommand } from "../model.js";

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
  diagnostics?: string;
  exitCode: number | null;
  reviewDecision?: "approved" | "changes-requested" | "blocked";
  review?: ReviewerResponse;
}

export const reviewerResponseSchema = z
  .object({
    schemaVersion: z.literal(2),
    taskId: z.string().trim().min(1).max(200),
    changeId: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(["approved", "changes-requested", "blocked"]),
    summary: z.string().trim().min(1).max(2_000),
    findings: z
      .array(
        z
          .object({
            severity: z.enum(["critical", "high", "medium", "low"]),
            path: z.string().min(1).optional(),
            evidence: z.string().trim().min(1).max(4_000),
            requiredOutcome: z.string().trim().min(1).max(4_000),
          })
          .strict(),
      )
      .max(100),
    learningCandidates: z
      .array(
        z
          .object({
            kind: z.enum(["knowledge", "decision", "procedure", "verification", "none"]),
            destination: z.string().min(1),
            evidence: z.array(z.string().min(1).max(1_000)).min(1).max(20),
            expectedValue: z.string().min(1),
            content: z.string().min(1).max(4_000),
            whyNotExecutable: z.string().min(1),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

export type ReviewerResponse = z.infer<typeof reviewerResponseSchema>;

export interface AgentAdapter {
  id: string;
  mode: "manual" | "command";
  availability(): Promise<{ available: boolean; reason: string }>;
  preflight?(request: {
    cwd: string;
    repositoryRoot: string;
    verification: VerificationCommand[];
  }): Promise<AgentPreflightResult>;
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

export function parseReviewerResponse(
  output: string,
  expected?: { taskId: string; changeId: string },
): ReviewerResponse | undefined {
  try {
    const decoded: unknown = JSON.parse(output);
    const parsed = reviewerResponseSchema.safeParse(decoded);
    if (!parsed.success) return undefined;
    if (
      expected &&
      (parsed.data.taskId !== expected.taskId || parsed.data.changeId !== expected.changeId)
    ) {
      return undefined;
    }
    return parsed.data;
  } catch {
    return undefined;
  }
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
    private readonly healthCheck?: {
      executable: string;
      args: string[];
      timeoutMs: number;
    },
  ) {}

  async preflight(request: {
    cwd: string;
    repositoryRoot: string;
    verification: VerificationCommand[];
  }): Promise<AgentPreflightResult> {
    return preflightCommandAdapter({
      executable: this.executable,
      args: this.args,
      cwd: request.cwd,
      repositoryRoot: request.repositoryRoot,
      verification: request.verification,
      ...(this.healthCheck === undefined ? {} : { health: this.healthCheck }),
      runner: this.runner,
    });
  }

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
      const result: AgentResult = {
        invoked: true,
        status: evidence.exitCode === 0 ? "completed" : "failed",
        summary:
          evidence.exitCode === 0
            ? `${request.role} command completed.`
            : `${request.role} command exited with ${evidence.exitCode ?? evidence.signal ?? "an error"}.`,
        output: evidence.stdout,
        ...(evidence.stderr ? { diagnostics: evidence.stderr } : {}),
        exitCode: evidence.exitCode,
      };
      if (request.role === "reviewer") {
        const candidate = request.package as { taskId?: unknown; changeId?: unknown };
        const expected =
          typeof candidate.taskId === "string" && typeof candidate.changeId === "string"
            ? { taskId: candidate.taskId, changeId: candidate.changeId }
            : undefined;
        const review =
          evidence.exitCode === 0 && !evidence.outputTruncated && expected
            ? parseReviewerResponse(evidence.stdout, expected)
            : undefined;
        if (review) {
          result.review = review;
          result.reviewDecision = review.decision;
          result.summary = review.summary;
        } else {
          result.reviewDecision = "blocked";
          result.summary =
            evidence.exitCode === 0
              ? "Reviewer output was not one complete schema-valid JSON response."
              : "Reviewer process did not exit successfully; its decision was ignored.";
        }
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
    runProcess,
    adapter.healthCheck,
  );
}
