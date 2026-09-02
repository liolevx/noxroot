#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError, Option } from "commander";
import { configuredAgent, ManualAgentAdapter } from "./adapters/agents.js";
import { boundedDiff, prepareIsolatedWorktree } from "./adapters/vcs.js";
import { loadConfig } from "./config/load.js";
import { buildContext } from "./core/context.js";
import { doctorRepository } from "./core/doctor.js";
import { applyProposals } from "./core/init.js";
import { previewRepository } from "./core/preview.js";
import { buildProposals } from "./core/proposals.js";
import { applyLearning, proposeLearnings } from "./knowledge/learn.js";
import type { PreviewResult } from "./model.js";
import { orchestrateRun, type RunRecord } from "./orchestration/run.js";
import { renderContext, renderPreview, renderVerification } from "./output.js";
import { readRunRecord, writeRunRecord } from "./state/local.js";
import { changedFiles, executeVerification, planVerification } from "./verification/index.js";

const VERSION = "0.1.0";
const DESCRIPTION =
  "Local CLI for task-specific coding-agent context, approved verification, independent review, and validated project knowledge.";

export const EXIT = {
  success: 0,
  usage: 2,
  refused: 3,
  verification: 4,
  agent: 5,
  interrupted: 130,
} as const;

interface Io {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  isTTY: boolean;
}

interface GlobalOptions {
  root: string;
  json?: boolean;
  color?: boolean;
}

function writeJson(io: Io, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function emit(io: Io, asJson: boolean | undefined, value: unknown, human: string): void {
  if (asJson) writeJson(io, value);
  else io.stdout(human);
}

function globals(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

async function confirm(io: Io, prompt: string, assumed = false): Promise<boolean> {
  if (assumed) return true;
  if (!io.isTTY) return false;
  const readline = createInterface({ input: defaultStdin, output: defaultStdout });
  try {
    const answer = await readline.question(`${prompt} [y/N] `);
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

async function selectModules(preview: PreviewResult, io: Io): Promise<PreviewResult> {
  if (!io.isTTY) throw new Error("init --select requires an interactive terminal.");
  const readline = createInterface({ input: defaultStdin, output: defaultStdout });
  try {
    io.stdout(`${preview.modules.map((module) => `${module.id} (${module.status})`).join("\n")}\n`);
    const answer = await readline.question(
      "Enable module ids (comma-separated; blank keeps recommended modules): ",
    );
    if (!answer.trim()) return preview;
    const selected = new Set(answer.split(",").map((value) => value.trim()));
    const unknown = [...selected].filter(
      (id) => !preview.modules.some((module) => module.id === id),
    );
    if (unknown.length) throw new Error(`Unknown module id(s): ${unknown.join(", ")}`);
    const modules = preview.modules.map((module) =>
      selected.has(module.id)
        ? { ...module, status: "enabled" as const }
        : {
            ...module,
            status: "disabled" as const,
            reason: "Disabled during confirmed selection.",
          },
    );
    return { ...preview, modules, proposedFiles: buildProposals(preview.profile, modules) };
  } finally {
    readline.close();
  }
}

function renderDoctor(result: Awaited<ReturnType<typeof doctorRepository>>): string {
  const lines = [
    "NOXROOT DOCTOR",
    result.healthy ? "No blocking configuration errors." : "Blocking errors found.",
  ];
  for (const finding of result.findings) {
    lines.push(
      `- ${finding.severity.toUpperCase()} ${finding.code}: ${finding.message}`,
      `  Next: ${finding.next}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function createId(): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${date}-${randomBytes(4).toString("hex")}`;
}

export function createProgram(customIo?: Partial<Io>): Command {
  const io: Io = {
    stdout: customIo?.stdout ?? ((value) => process.stdout.write(value)),
    stderr: customIo?.stderr ?? ((value) => process.stderr.write(value)),
    isTTY: customIo?.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
  };
  const program = new Command();
  program
    .exitOverride()
    .name("noxroot")
    .description(DESCRIPTION)
    .version(VERSION)
    .addOption(new Option("--root <path>", "repository root").default(process.cwd()))
    .option("--json", "emit machine-readable JSON to stdout")
    .option("--no-color", "disable color output")
    .showHelpAfterError()
    .configureOutput({
      writeOut: io.stdout,
      writeErr: io.stderr,
    });

  program
    .command("preview")
    .description("perform a strict read-only repository diagnosis")
    .option("--module <id>", "show one module assessment")
    .action(async (options: { module?: string }, command: Command) => {
      const common = globals(command);
      let result = await previewRepository(common.root);
      if (options.module) {
        const modules = result.modules.filter((module) => module.id === options.module);
        if (!modules.length) throw new Error(`Unknown module id: ${options.module}`);
        result = { ...result, modules };
      }
      emit(io, common.json, result, renderPreview(result));
    });

  program
    .command("init")
    .description("create the confirmed minimum Noxroot setup")
    .option("--dry-run", "alias the read-only preview")
    .option("--select", "interactively select modules")
    .option("--yes", "confirm the complete displayed proposal non-interactively")
    .action(
      async (options: { dryRun?: boolean; select?: boolean; yes?: boolean }, command: Command) => {
        const common = globals(command);
        let preview = await previewRepository(common.root);
        if (options.select) preview = await selectModules(preview, io);
        if (common.json && !options.dryRun && !options.yes) {
          throw new Error(
            "Mutating init with --json requires --yes after a separate reviewed preview.",
          );
        }
        if (!common.json) io.stdout(renderPreview(preview));
        if (options.dryRun) {
          if (common.json) writeJson(io, preview);
          return;
        }
        if (preview.proposedFiles.length === 0) {
          if (common.json) writeJson(io, { preview, applied: { created: [] } });
          io.stderr("Noxroot is already initialized; no files were proposed.\n");
          return;
        }
        if (
          !(await confirm(
            io,
            `Create exactly ${preview.proposedFiles.length} proposed file(s)?`,
            options.yes,
          ))
        ) {
          process.exitCode = EXIT.refused;
          io.stderr(
            "Initialization cancelled; no files were changed. Use --yes only after reviewing the patch.\n",
          );
          return;
        }
        const result = await applyProposals(preview);
        if (common.json) writeJson(io, { preview, applied: result });
        else
          io.stdout(
            `Created ${result.created.length} file(s):\n${result.created.map((file) => `- ${file}`).join("\n")}\n`,
          );
      },
    );

  program
    .command("sync")
    .description("reinspect initialized setup and propose evidence-backed additions")
    .option("--dry-run", "show proposals without applying them")
    .option("--yes", "confirm the complete displayed proposal non-interactively")
    .action(async (options: { dryRun?: boolean; yes?: boolean }, command: Command) => {
      const common = globals(command);
      const preview = await previewRepository(common.root);
      if (common.json && !options.dryRun && !options.yes) {
        throw new Error(
          "Mutating sync with --json requires --yes after a separate reviewed preview.",
        );
      }
      if (!common.json) io.stdout(renderPreview(preview));
      if (options.dryRun || preview.proposedFiles.length === 0) {
        if (common.json) writeJson(io, { preview, applied: { created: [] } });
        return;
      }
      if (
        !(await confirm(io, `Create ${preview.proposedFiles.length} missing file(s)?`, options.yes))
      ) {
        process.exitCode = EXIT.refused;
        io.stderr("Synchronization cancelled; no files were changed.\n");
        return;
      }
      const result = await applyProposals(preview);
      if (common.json) writeJson(io, { preview, applied: result });
      else io.stdout(`Created: ${result.created.join(", ")}\n`);
    });

  program
    .command("doctor")
    .description("report configuration, safety, knowledge, and module problems")
    .action(async (_options: unknown, command: Command) => {
      const common = globals(command);
      const result = await doctorRepository(common.root);
      emit(io, common.json, result, renderDoctor(result));
      if (!result.healthy) process.exitCode = EXIT.usage;
    });

  program
    .command("context")
    .description("produce bounded context for a task without invoking an agent")
    .argument("<task>", "bounded task description")
    .action(async (task: string, _options: unknown, command: Command) => {
      const common = globals(command);
      const result = await buildContext(task, common.root);
      emit(io, common.json, result, renderContext(result));
    });

  program
    .command("verify")
    .description("plan or run repository-approved relevant checks")
    .option("--changed", "route checks from the current change set")
    .option("--task <task-id>", "associate verification with a recorded task")
    .option("--plan", "show checks without running them")
    .action(
      async (options: { changed?: boolean; task?: string; plan?: boolean }, command: Command) => {
        const common = globals(command);
        const changed = options.changed ? await changedFiles(common.root) : [];
        const checks = await planVerification(common.root, changed);
        if (options.plan) {
          const result = { taskId: options.task, changed, checks, executed: false };
          emit(
            io,
            common.json,
            result,
            `NOXROOT VERIFY PLAN\nChecks planned: ${checks.length}\n${checks.map((check) => `- ${check.executable} ${check.args.join(" ")}`).join("\n")}\n`,
          );
          return;
        }
        const controller = new AbortController();
        const interrupt = (): void => controller.abort();
        process.once("SIGINT", interrupt);
        process.once("SIGTERM", interrupt);
        try {
          const results = await executeVerification(common.root, checks, {
            signal: controller.signal,
          });
          emit(io, common.json, results, renderVerification(results));
          if (controller.signal.aborted) process.exitCode = EXIT.interrupted;
          else if (results.some((result) => result.status !== "passed"))
            process.exitCode = EXIT.verification;
        } finally {
          process.removeListener("SIGINT", interrupt);
          process.removeListener("SIGTERM", interrupt);
        }
      },
    );

  program
    .command("run")
    .description("coordinate a bounded worker, verification, and independent-review flow")
    .argument("<task>", "bounded task description")
    .option("--guided", "emit the task/context/verification package without an agent call")
    .option("--dry-run", "show the exact run plan with no commands, agents, or writes")
    .option("--yes", "confirm the displayed delegated run plan non-interactively")
    .action(
      async (
        task: string,
        options: { guided?: boolean; dryRun?: boolean; yes?: boolean },
        command: Command,
      ) => {
        const common = globals(command);
        const root = path.resolve(common.root);
        const context = await buildContext(task, root);
        const config = await loadConfig(root);
        const adapter = options.guided ? new ManualAgentAdapter() : configuredAgent(config);
        const checks = await planVerification(root);
        const id = createId();
        const plan = {
          id,
          task,
          repository: root,
          adapter: adapter.id,
          calls:
            adapter.mode === "manual"
              ? { worker: 0, reviewer: 0, repairMaximum: 0 }
              : {
                  workerMaximum: config?.budgets.workerCalls ?? 2,
                  reviewerMaximum: config?.budgets.reviewerCalls ?? 2,
                  repairMaximum: config?.budgets.repairIterations ?? 1,
                },
          contextBudgetBytes: context.budget.maximumBytes,
          verification: checks,
          writableScope: adapter.mode === "manual" ? "none" : "new isolated Git worktree",
          sideEffects:
            adapter.mode === "manual"
              ? []
              : [
                  "create branch and worktree",
                  "invoke configured command adapter",
                  "run approved checks",
                  "write bounded local evidence",
                ],
          prohibited: [
            "push",
            "merge",
            "deploy",
            "discard dirty work",
            "authorize worker-added checks",
          ],
          executes: !options.dryRun && !options.guided && adapter.mode !== "manual",
        };
        const planningOnly = options.dryRun || options.guided || adapter.mode === "manual";
        if (common.json && !planningOnly && !options.yes) {
          throw new Error(
            "Delegated run with --json requires --yes after a separate reviewed --dry-run.",
          );
        }
        if (planningOnly) {
          emit(
            io,
            common.json,
            { plan, context },
            `NOXROOT RUN PLAN\n${JSON.stringify(plan, null, 2)}\n\n${renderContext(context)}`,
          );
        } else if (!common.json) {
          io.stdout(
            `NOXROOT RUN PLAN\n${JSON.stringify(plan, null, 2)}\n\n${renderContext(context)}`,
          );
        } else {
          io.stderr(`NOXROOT RUN PLAN ${JSON.stringify(plan)}\n`);
        }
        if (planningOnly) return;
        if (!(await confirm(io, "Start this delegated run?", options.yes))) {
          process.exitCode = EXIT.refused;
          io.stderr("Run cancelled; no branch, worktree, agent call, or check was created.\n");
          return;
        }
        const worktree = await prepareIsolatedWorktree(root, task, id);
        const controller = new AbortController();
        const interrupt = (): void => controller.abort();
        process.once("SIGINT", interrupt);
        process.once("SIGTERM", interrupt);
        try {
          const record = await orchestrateRun(
            {
              id,
              task,
              context,
              cwd: worktree.path,
              repositoryRoot: worktree.path,
              adapter,
              budgets: config?.budgets ?? {
                workerCalls: 2,
                reviewerCalls: 2,
                repairIterations: 1,
                outputBytes: 65_536,
              },
              branch: worktree.branch,
              signal: controller.signal,
            },
            {
              verify: () =>
                executeVerification(worktree.path, checks, { signal: controller.signal }),
              diff: () => boundedDiff(worktree),
            },
          );
          const recordPath = await writeRunRecord(root, id, record);
          emit(
            io,
            common.json,
            { plan, context, record, recordPath },
            `${record.handoff}\n\nEvidence: ${recordPath}\n`,
          );
          if (controller.signal.aborted) process.exitCode = EXIT.interrupted;
          else if (record.status !== "approved") process.exitCode = EXIT.agent;
        } finally {
          process.removeListener("SIGINT", interrupt);
          process.removeListener("SIGTERM", interrupt);
        }
      },
    );

  program
    .command("learn")
    .description("propose controlled durable improvements from a completed run")
    .requiredOption("--task <task-id>", "completed task id")
    .option("--apply", "apply non-duplicate proposals after explicit confirmation")
    .option("--yes", "confirm proposal application non-interactively")
    .action(async (options: { task: string; apply?: boolean; yes?: boolean }, command: Command) => {
      const common = globals(command);
      const record = await readRunRecord<RunRecord>(common.root, options.task);
      const result = await proposeLearnings(common.root, record);
      if (common.json && options.apply && !options.yes) {
        throw new Error(
          "Learning application with --json requires --yes after a separate reviewed proposal.",
        );
      }
      if (!common.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      if (!options.apply || result.proposals.length === 0) {
        if (common.json) writeJson(io, result);
        return;
      }
      if (
        !(await confirm(io, `Apply ${result.proposals.length} learning proposal(s)?`, options.yes))
      ) {
        process.exitCode = EXIT.refused;
        io.stderr("Learning application cancelled; durable knowledge was not changed.\n");
        return;
      }
      const applied: string[] = [];
      for (const proposal of result.proposals) {
        applied.push(await applyLearning(common.root, proposal));
      }
      if (common.json) writeJson(io, { ...result, applied });
      else io.stdout(`Applied ${result.proposals.length} proposal(s).\n`);
    });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  try {
    await createProgram().parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return;
      process.exitCode = error.exitCode;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Noxroot could not complete the request: ${message}\nWhy it matters: the requested operation stopped before unsafe assumptions were made.\nNext: correct the reported input or run noxroot doctor.\n`,
    );
    process.exitCode = EXIT.usage;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
