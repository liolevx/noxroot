#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError, Option } from "commander";
import { configuredAgent, ManualAgentAdapter } from "./adapters/agents.js";
import {
  boundedDiff,
  captureRepositoryBaseline,
  prepareIsolatedWorktree,
  revisionInCurrentHistory,
} from "./adapters/vcs.js";
import { loadConfig } from "./config/load.js";
import type { NoxrootConfig } from "./config/schema.js";
import { buildContext } from "./core/context.js";
import { doctorRepository } from "./core/doctor.js";
import { applyProposals } from "./core/init.js";
import { previewRepository } from "./core/preview.js";
import { buildProposals } from "./core/proposals.js";
import { inspectRepositoryAdoption } from "./detection/adoption.js";
import { cliCommand, VERSION } from "./invocation.js";
import { applyLearning, proposeLearnings } from "./knowledge/learn.js";
import type { PreviewResult } from "./model.js";
import { effectiveAutonomy } from "./orchestration/autonomy.js";
import {
  finishGuidedRun,
  inspectGuidedContinuation,
  startGuidedRun,
  type GuidedContinuationState,
  type GuidedRunRecord,
} from "./orchestration/guided.js";
import { orchestrateRun, type RunRecord } from "./orchestration/run.js";
import {
  renderContext,
  renderInitMark,
  renderPreview,
  renderVerification,
  renderVerificationPlan,
  renderWelcome,
  type RenderOptions,
} from "./output.js";
import {
  listRunRecords,
  localStateRoot,
  readRunRecord,
  replaceRunRecord,
  writeRunRecord,
} from "./state/local.js";
import {
  changedFiles,
  executeVerification,
  planVerification,
  selectVerification,
} from "./verification/index.js";

const DESCRIPTION =
  "Noxroot gives coding agents relevant repository context, checks each change, and proposes validated lessons as reusable project documentation.";

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
  columns: number;
}

interface GlobalOptions {
  root: string;
  json?: boolean;
  color?: boolean;
  verbose?: boolean;
}

function writeJson(io: Io, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function emit(io: Io, asJson: boolean | undefined, value: unknown, human: string): void {
  if (asJson) writeJson(io, value);
  else io.stdout(human);
}

function progress(io: Io, message: string): void {
  io.stderr(`${message}\n`);
}

function moduleAvailable(
  config: NoxrootConfig | undefined,
  module: NoxrootConfig["modules"][number],
): boolean {
  return config === undefined || config.modules.includes(module);
}

function refuseDisabledModule(
  io: Io,
  asJson: boolean | undefined,
  config: NoxrootConfig | undefined,
  module: "orchestration" | "learning",
): boolean {
  if (moduleAvailable(config, module)) return false;
  const reason =
    module === "orchestration"
      ? `Noxroot lifecycle is disabled for this repository. Its existing repository coordinator remains authoritative. Use ${cliCommand('context "<task>"')} or ${cliCommand("verify --plan")} without creating a second task lifecycle.`
      : "Noxroot learning is disabled for this repository. Follow the repository's existing workflow for durable knowledge.";
  emit(io, asJson, { refused: { module, reason } }, `${reason}\n`);
  process.exitCode = EXIT.refused;
  return true;
}

function globals(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function renderOptions(io: Io, options: GlobalOptions): RenderOptions {
  return {
    color: io.isTTY && options.color !== false && process.env.NO_COLOR === undefined,
    verbose: options.verbose ?? false,
    width: io.columns,
  };
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
    const unavailable = preview.modules.filter(
      (module) => selected.has(module.id) && ["blocked", "not applicable"].includes(module.status),
    );
    if (unavailable.length) {
      throw new Error(
        `Cannot enable unavailable module(s): ${unavailable.map((module) => `${module.id} (${module.reason})`).join(", ")}`,
      );
    }
    const modules = preview.modules.map((module) =>
      selected.has(module.id)
        ? { ...module, status: "enabled" as const }
        : {
            ...module,
            status: "disabled" as const,
            reason: "Disabled during confirmed selection.",
          },
    );
    const adoption = await inspectRepositoryAdoption(preview.profile);
    return {
      ...preview,
      modules,
      proposedFiles: await buildProposals(preview.profile, modules, adoption),
    };
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

const RETRYABLE_GUIDED_STATUSES = new Set<RunRecord["status"]>([
  "running",
  "review-pending",
  "changes-requested",
  "failed",
  "blocked",
  "incomplete",
]);

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function normalizedTask(task: string): string {
  return task
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isGuidedRecord(value: unknown): value is GuidedRunRecord {
  const record = value as Partial<GuidedRunRecord> | undefined;
  return Boolean(
    record &&
    record.mode === "guided" &&
    typeof record.id === "string" &&
    typeof record.task === "string" &&
    typeof record.status === "string" &&
    typeof record.repository?.root === "string" &&
    typeof record.baseline?.revision === "string",
  );
}

async function activeGuidedRecords(root: string): Promise<GuidedRunRecord[]> {
  const current = await captureRepositoryBaseline(root);
  const records = await listRunRecords<unknown>(root);
  return records.filter(
    (value): value is GuidedRunRecord =>
      isGuidedRecord(value) &&
      RETRYABLE_GUIDED_STATUSES.has(value.status) &&
      samePath(value.repository.root, current.root) &&
      (value.repository.branch === undefined || value.repository.branch === current.branch),
  );
}

async function findGuidedContinuation(
  root: string,
  task: string,
): Promise<GuidedRunRecord | undefined> {
  const matching = (await activeGuidedRecords(root)).filter(
    (record) => normalizedTask(record.task) === normalizedTask(task),
  );
  const compatible: GuidedRunRecord[] = [];
  const stale: GuidedRunRecord[] = [];
  for (const record of matching) {
    if (await revisionInCurrentHistory(root, record.baseline.revision)) compatible.push(record);
    else stale.push(record);
  }
  if (compatible.length > 1) {
    throw new Error(
      `Multiple active guided tasks match this request: ${compatible.map((record) => record.id).join(", ")}. Finish with --task <id> before starting again.`,
    );
  }
  if (compatible.length === 1) return compatible[0];
  if (stale.length > 0) {
    throw new Error(
      `Active task ${stale.map((record) => record.id).join(", ")} matches this request but its baseline is not in the current branch history. Return to its recorded branch or finish it explicitly with --task <id>.`,
    );
  }
  return undefined;
}

async function inferGuidedTaskId(root: string, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const active = await activeGuidedRecords(root);
  const eligible: GuidedRunRecord[] = [];
  const stale: GuidedRunRecord[] = [];
  for (const record of active) {
    if (await revisionInCurrentHistory(root, record.baseline.revision)) eligible.push(record);
    else stale.push(record);
  }
  if (eligible.length === 1) return eligible[0]!.id;
  if (eligible.length === 0) {
    if (stale.length > 0) {
      throw new Error(
        `Active guided task state is incompatible with the current branch history: ${stale.map((record) => record.id).join(", ")}. Return to the recorded branch or select a compatible task explicitly with --task <id>.`,
      );
    }
    throw new Error(
      `No active guided task was found. Start one with ${cliCommand('start "<task>"')}.`,
    );
  }
  throw new Error(
    `Multiple active guided tasks need an explicit --task id: ${eligible.map((record) => record.id).join(", ")}`,
  );
}

function renderContinuation(
  record: GuidedRunRecord,
  recordPath: string,
  continuation: GuidedContinuationState,
): string {
  const changed = continuation.changedPaths.length;
  const changedSummary = changed
    ? `${changed} file${changed === 1 ? "" : "s"} since baseline${changed <= 5 ? ` (${continuation.changedPaths.join(", ")})` : ""}`
    : "no files since baseline";
  return `${[
    "Continuing active task",
    `  Outcome: ${record.context.intent.requiredOutcomes[0] ?? record.context.interpretation}`,
    `  Task: ${record.id}`,
    `  Baseline: ${record.baseline.revision.slice(0, 12)}`,
    `  Changed: ${changedSummary}`,
    `  Verification: ${continuation.verification.summary}`,
    "  No duplicate task was created.",
    `Next: ${continuation.nextAction}`,
    `Local record: ${recordPath}`,
  ].join("\n")}\n`;
}

function renderStart(
  id: string,
  context: Awaited<ReturnType<typeof buildContext>>,
  checks: Awaited<ReturnType<typeof planVerification>>,
  recordPath: string,
): string {
  return `${[
    "Preparing",
    `  Outcome: ${context.intent.requiredOutcomes[0] ?? context.interpretation}`,
    `  Exclusions: ${context.intent.explicitExclusions.join("; ") || "none"}`,
    `  Context: ${context.selected.length} relevant files · ~${context.budget.estimatedTokens.toLocaleString("en-US")} tokens`,
    `  Likely area: ${context.applicableAreas.join(", ") || "not yet established"}`,
    `  Checks: ${checks.map((check) => check.id).join(", ") || "none approved yet"}`,
    "  Coding agent: not invoked (manual mode)",
    "",
    "Ready for your coding agent.",
    `Task: ${id}`,
    `Next: make the change, then run ${cliCommand("finish")}.`,
    `Local record: ${recordPath}`,
  ].join("\n")}\n`;
}

export function createProgram(customIo?: Partial<Io>): Command {
  const io: Io = {
    stdout: customIo?.stdout ?? ((value) => process.stdout.write(value)),
    stderr: customIo?.stderr ?? ((value) => process.stderr.write(value)),
    isTTY: customIo?.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    columns: customIo?.columns ?? process.stdout.columns ?? 80,
  };
  const program = new Command();
  program
    .exitOverride()
    .name("noxroot")
    .description(DESCRIPTION)
    .version(VERSION)
    .addOption(new Option("--root <path>", "repository root").default(process.cwd()))
    .option("--json", "emit machine-readable JSON to stdout")
    .option("--verbose", "show detailed human-readable evidence")
    .option("--no-color", "disable color output")
    .showHelpAfterError()
    .configureOutput({
      writeOut: io.stdout,
      writeErr: io.stderr,
    })
    .action((_options: unknown, command: Command) => {
      const common = globals(command);
      if (common.json) {
        writeJson(io, { name: "noxroot", version: VERSION, description: DESCRIPTION });
      } else if (io.isTTY) {
        io.stdout(renderWelcome(renderOptions(io, common)));
      } else {
        command.outputHelp();
      }
    });

  program
    .command("preview")
    .description("perform a strict read-only repository diagnosis")
    .option("--module <id>", "show one module assessment")
    .option("--diff", "show exact proposed file patches")
    .action(async (options: { module?: string; diff?: boolean }, command: Command) => {
      const common = globals(command);
      let result = await previewRepository(common.root);
      if (options.module) {
        const modules = result.modules.filter((module) => module.id === options.module);
        if (!modules.length) throw new Error(`Unknown module id: ${options.module}`);
        result = { ...result, modules };
      }
      emit(
        io,
        common.json,
        result,
        renderPreview(result, {
          ...renderOptions(io, common),
          diff: options.diff ?? false,
          verbose: common.verbose === true || options.diff === true,
        }),
      );
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
        if (!common.json) {
          if (io.isTTY && !options.dryRun) io.stdout(renderInitMark(renderOptions(io, common)));
          io.stdout(
            renderPreview(preview, {
              ...renderOptions(io, common),
              diff: !options.dryRun,
              verbose: common.verbose || !options.dryRun,
            }),
          );
        }
        if (options.dryRun) {
          if (common.json) writeJson(io, preview);
          return;
        }
        if (!preview.initializationAllowed) {
          if (common.json) writeJson(io, { preview, applied: { created: [] }, refused: true });
          process.exitCode = EXIT.refused;
          io.stderr(
            "Initialization refused; resolve the reported instruction conflict. No files were changed.\n",
          );
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
    .option("--diff", "show exact proposed file patches")
    .option("--yes", "confirm the complete displayed proposal non-interactively")
    .action(
      async (options: { dryRun?: boolean; diff?: boolean; yes?: boolean }, command: Command) => {
        const common = globals(command);
        const preview = await previewRepository(common.root);
        if (common.json && !options.dryRun && !options.yes) {
          throw new Error(
            "Mutating sync with --json requires --yes after a separate reviewed preview.",
          );
        }
        if (!common.json)
          io.stdout(
            renderPreview(preview, {
              ...renderOptions(io, common),
              diff: options.diff || !options.dryRun,
              verbose: common.verbose || options.diff || !options.dryRun,
            }),
          );
        if (options.dryRun) {
          if (common.json) writeJson(io, { preview, applied: { created: [] } });
          return;
        }
        if (!preview.initializationAllowed) {
          if (common.json) writeJson(io, { preview, applied: { created: [] }, refused: true });
          process.exitCode = EXIT.refused;
          io.stderr(
            "Synchronization refused; resolve the reported instruction conflict. No files were changed.\n",
          );
          return;
        }
        if (preview.proposedFiles.length === 0) {
          if (common.json) writeJson(io, { preview, applied: { created: [] } });
          return;
        }
        if (
          !(await confirm(
            io,
            `Create ${preview.proposedFiles.length} missing file(s)?`,
            options.yes,
          ))
        ) {
          process.exitCode = EXIT.refused;
          io.stderr("Synchronization cancelled; no files were changed.\n");
          return;
        }
        const result = await applyProposals(preview);
        if (common.json) writeJson(io, { preview, applied: result });
        else io.stdout(`Created: ${result.created.join(", ")}\n`);
      },
    );

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
      emit(io, common.json, result, renderContext(result, renderOptions(io, common)));
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
            renderVerificationPlan(changed, checks, {
              ...renderOptions(io, common),
              changedOnly: options.changed === true,
            }),
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
          emit(io, common.json, results, renderVerification(results, renderOptions(io, common)));
          if (controller.signal.aborted) process.exitCode = EXIT.interrupted;
          else if (results.length === 0 || results.some((result) => result.status !== "passed"))
            process.exitCode = EXIT.verification;
        } finally {
          process.removeListener("SIGINT", interrupt);
          process.removeListener("SIGTERM", interrupt);
        }
      },
    );

  program
    .command("start")
    .description("prepare a guided task for the coding agent you already use")
    .argument("<task>", "task outcome, exclusions, and acceptance criteria")
    .action(async (task: string, _options: unknown, command: Command) => {
      const common = globals(command);
      const root = path.resolve(common.root);
      const config = await loadConfig(root);
      if (refuseDisabledModule(io, common.json, config, "orchestration")) return;
      const continuation = await findGuidedContinuation(root, task);
      if (continuation) {
        const continuationState = await inspectGuidedContinuation(
          root,
          continuation,
          config?.sensitivePaths ?? [],
        );
        const recordPath = path.join(await localStateRoot(root), "runs", `${continuation.id}.json`);
        emit(
          io,
          common.json,
          {
            context: continuation.context,
            record: continuation,
            recordPath,
            agentInvoked: false,
            continued: true,
            continuation: continuationState,
          },
          renderContinuation(continuation, recordPath, continuationState),
        );
        return;
      }
      const context = await buildContext(task, root);
      const autonomy = effectiveAutonomy(config);
      if (!autonomy.guided.authorized) {
        emit(io, common.json, { refused: autonomy.guided, context }, `${autonomy.guided.reason}\n`);
        process.exitCode = EXIT.refused;
        return;
      }
      const checks = await planVerification(root);
      const id = createId();
      const record = await startGuidedRun({
        id,
        task,
        root,
        context,
        effectiveAutonomy: autonomy,
        trustedVerificationPolicy: checks,
      });
      const recordPath = await writeRunRecord(root, id, record);
      emit(
        io,
        common.json,
        { context, record, recordPath, agentInvoked: false },
        renderStart(id, context, checks, recordPath),
      );
    });

  program
    .command("run")
    .description("coordinate a bounded worker, verification, and independent-review flow")
    .argument("<task>", "bounded task description")
    .option("--guided", "record a portable task package for an external coding agent")
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
        const config = await loadConfig(root);
        if (refuseDisabledModule(io, common.json, config, "orchestration")) return;
        progress(io, "Preparing context");
        const context = await buildContext(task, root);
        const adapter = options.guided ? new ManualAgentAdapter() : configuredAgent(config);
        const checks = await planVerification(root);
        const autonomy = effectiveAutonomy(config);
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
          autonomy,
          writableScope: options.guided
            ? "local Noxroot run evidence only"
            : adapter.mode === "manual"
              ? "none"
              : "new isolated Git worktree",
          sideEffects: options.guided
            ? ["write one bounded local run record"]
            : adapter.mode === "manual"
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
          executes:
            !options.dryRun &&
            !options.guided &&
            adapter.mode !== "manual" &&
            autonomy.worker.authorized,
        };

        if (options.dryRun) {
          emit(
            io,
            common.json,
            { plan, context },
            `NOXROOT RUN PLAN\n${JSON.stringify(plan, null, 2)}\n\n${renderContext(context)}`,
          );
          return;
        }
        if (options.guided) {
          if (!autonomy.guided.authorized) {
            emit(
              io,
              common.json,
              { plan, refused: autonomy.guided },
              `${autonomy.guided.reason}\n`,
            );
            process.exitCode = EXIT.refused;
            return;
          }
          const record = await startGuidedRun({
            id,
            task,
            root,
            context,
            effectiveAutonomy: autonomy,
            trustedVerificationPolicy: checks,
          });
          const recordPath = await writeRunRecord(root, id, record);
          emit(
            io,
            common.json,
            { plan, context, record, recordPath },
            `NOXROOT GUIDED TASK\nTask id: ${id}\nSelected context: ${context.selected.length} files (~${context.budget.estimatedTokens} tokens)\nApproved checks captured: ${checks.length}\nNo agent was invoked.\nNext: ${cliCommand(`finish --task ${id}`)}\nEvidence: ${recordPath}\n`,
          );
          return;
        }
        if (adapter.mode === "manual") {
          emit(
            io,
            common.json,
            { plan, context },
            `NOXROOT RUN PLAN\n${JSON.stringify(plan, null, 2)}\n\n${renderContext(context)}Next: rerun with --guided to record a completable task.\n`,
          );
          return;
        }
        if (!autonomy.worker.authorized) {
          emit(io, common.json, { plan, refused: autonomy.worker }, `${autonomy.worker.reason}\n`);
          process.exitCode = EXIT.refused;
          return;
        }
        if (common.json && !options.yes) {
          throw new Error(
            "Delegated run with --json requires --yes after a separate reviewed --dry-run.",
          );
        }
        if (!common.json) {
          io.stdout(
            `NOXROOT RUN PLAN\n${JSON.stringify(plan, null, 2)}\n\n${renderContext(context)}`,
          );
        } else {
          io.stderr(`NOXROOT RUN PLAN ${JSON.stringify(plan)}\n`);
        }
        if (!(await confirm(io, "Start this delegated run?", options.yes))) {
          process.exitCode = EXIT.refused;
          io.stderr("Run cancelled; no branch, worktree, agent call, or check was created.\n");
          return;
        }
        progress(io, "Checking configured agent and repository prerequisites");
        const preflight = adapter.preflight
          ? await adapter.preflight({ cwd: root, repositoryRoot: root, verification: checks })
          : {
              ok: true,
              checks: [],
              diagnostics: [],
              retry: "Rerun the same command after correcting the reported prerequisite.",
            };
        if (!preflight.ok) {
          const human = `${[
            "NOXROOT PREFLIGHT",
            ...preflight.checks.map((check) => `- ${check.id}: ${check.status} — ${check.detail}`),
            ...(preflight.diagnostics.length
              ? ["", "Diagnostics", ...preflight.diagnostics.map((line) => `  ${line}`)]
              : []),
            "",
            `Next: ${preflight.retry}`,
          ].join("\n")}\n`;
          emit(io, common.json, { plan, context, preflight }, human);
          process.exitCode = EXIT.agent;
          return;
        }
        const worktree = await prepareIsolatedWorktree(root, task, id);
        progress(io, "Starting coding agent");
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
              reviewAuthorized: autonomy.reviewer.authorized,
              branch: worktree.branch,
              signal: controller.signal,
            },
            {
              verify: async () => {
                progress(io, "Checking changed files");
                const actualChanged = await changedFiles(worktree.path, worktree.baseRevision);
                const affectedChecks = selectVerification(checks, actualChanged);
                progress(io, `Running ${affectedChecks.length} approved check(s)`);
                return executeVerification(worktree.path, affectedChecks, {
                  signal: controller.signal,
                });
              },
              diff: () => boundedDiff(worktree, config?.sensitivePaths ?? []),
            },
          );
          const recordPath = await writeRunRecord(root, id, record);
          progress(io, "Preparing handoff");
          emit(
            io,
            common.json,
            { plan, context, record, recordPath },
            `${record.handoff}\n\nEvidence: ${recordPath}\n`,
          );
          if (controller.signal.aborted) process.exitCode = EXIT.interrupted;
          else if (!["approved", "completed"].includes(record.status))
            process.exitCode = EXIT.agent;
        } finally {
          process.removeListener("SIGINT", interrupt);
          process.removeListener("SIGTERM", interrupt);
        }
      },
    );

  program
    .command("finish")
    .description("close a guided task with affected checks and independent review")
    .option("--task <task-id>", "guided task id; inferred when exactly one task is active")
    .option(
      "--review-file <path>",
      "repository-relative file containing one strict reviewer JSON response",
    )
    .action(async (options: { task?: string; reviewFile?: string }, command: Command) => {
      const common = globals(command);
      const root = path.resolve(common.root);
      const config = await loadConfig(root);
      if (refuseDisabledModule(io, common.json, config, "orchestration")) return;
      const taskId = await inferGuidedTaskId(root, options.task);
      const record = await readRunRecord<GuidedRunRecord>(root, taskId);
      const autonomy = effectiveAutonomy(config);
      const adapter = configuredAgent(config);
      const controller = new AbortController();
      const interrupt = (): void => controller.abort();
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      try {
        progress(io, "Inspecting changed files and running affected checks");
        const finished = await finishGuidedRun({
          root,
          record,
          adapter,
          reviewAuthorized: autonomy.reviewer.authorized,
          sensitivePaths: config?.sensitivePaths ?? [],
          ...(options.reviewFile === undefined ? {} : { reviewFile: options.reviewFile }),
          signal: controller.signal,
        });
        const recordPath = await replaceRunRecord(root, taskId, finished);
        progress(io, "Assessing reusable learning");
        const learning = await proposeLearnings(root, finished);
        const completion = {
          documentation: {
            status: "not-assessed" as const,
            reason: "No deterministic documentation signal was produced.",
          },
          learning: {
            status:
              learning.proposals.length > 0 ? ("proposed" as const) : ("no-candidate" as const),
            proposals: learning.proposals.length,
          },
        };
        progress(io, "Preparing handoff");
        emit(
          io,
          common.json,
          { record: finished, recordPath, completion, learning },
          `${finished.handoff}\n\nDocumentation\n  Not assessed automatically; no deterministic documentation signal was produced.\n\nLearning\n  ${learning.proposals.length ? `${learning.proposals.length} reusable proposal(s) available; inspect with ${cliCommand(`learn --task ${taskId}`)}.` : "No reusable project-knowledge candidate identified."}\n\nLocal record: ${recordPath}\n`,
        );
        if (controller.signal.aborted) process.exitCode = EXIT.interrupted;
        else if (finished.status === "incomplete") process.exitCode = EXIT.verification;
        else if (!["approved", "completed", "review-pending"].includes(finished.status))
          process.exitCode = EXIT.agent;
      } finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
      }
    });

  program
    .command("learn")
    .description("propose controlled durable improvements from a completed run")
    .requiredOption("--task <task-id>", "completed task id")
    .option("--apply", "apply non-duplicate proposals after explicit confirmation")
    .option("--yes", "confirm proposal application non-interactively")
    .action(async (options: { task: string; apply?: boolean; yes?: boolean }, command: Command) => {
      const common = globals(command);
      const config = await loadConfig(common.root);
      if (refuseDisabledModule(io, common.json, config, "learning")) return;
      const record = await readRunRecord<RunRecord>(common.root, options.task);
      const result = await proposeLearnings(common.root, record);
      const applicable = result.proposals.filter(
        (proposal) => proposal.duplication === "not-found" && proposal.conflict === "none",
      );
      if (common.json && options.apply && !options.yes) {
        throw new Error(
          "Learning application with --json requires --yes after a separate reviewed proposal.",
        );
      }
      if (!common.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      if (!options.apply || applicable.length === 0) {
        if (common.json) writeJson(io, result);
        return;
      }
      if (!(await confirm(io, `Apply ${applicable.length} learning proposal(s)?`, options.yes))) {
        process.exitCode = EXIT.refused;
        io.stderr("Learning application cancelled; durable knowledge was not changed.\n");
        return;
      }
      const applied: string[] = [];
      for (const proposal of applicable) {
        applied.push(...(await applyLearning(common.root, proposal)));
      }
      if (common.json) writeJson(io, { ...result, applied });
      else io.stdout(`Applied ${applicable.length} proposal(s).\n`);
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

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isEntrypoint()) {
  await main();
}
