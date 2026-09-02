import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { ConfigurationError, loadConfig, loadRoutes, loadVerification } from "../config/load.js";
import type { NoxrootConfig, RoutesConfig, VerificationConfig } from "../config/schema.js";
import { scanRepository } from "../detection/scan.js";
import { isWithin } from "../security/paths.js";
import { localStateRoot } from "../state/local.js";

export interface DoctorFinding {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  next: string;
}

export interface DoctorResult {
  root: string;
  healthy: boolean;
  findings: DoctorFinding[];
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function commandAvailable(root: string, executable: string): Promise<boolean> {
  if (executable.includes("/") || executable.includes("\\")) {
    return exists(path.resolve(root, executable));
  }
  if (process.platform === "win32" && ["npm", "npx"].includes(executable.toLowerCase())) {
    return exists(
      path.join(
        path.dirname(process.execPath),
        "node_modules",
        "npm",
        "bin",
        executable.toLowerCase() === "npm" ? "npm-cli.js" : "npx-cli.js",
      ),
    );
  }
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      if (await exists(path.join(directory, `${executable}${extension}`))) return true;
    }
  }
  return false;
}

function finding(
  severity: DoctorFinding["severity"],
  code: string,
  message: string,
  next: string,
): DoctorFinding {
  return { severity, code, message, next };
}

export async function doctorRepository(root = process.cwd()): Promise<DoctorResult> {
  root = path.resolve(root);
  const findings: DoctorFinding[] = [];
  let config: NoxrootConfig | undefined;
  let routes: RoutesConfig | undefined;
  let verification: VerificationConfig | undefined;
  try {
    config = await loadConfig(root);
    routes = await loadRoutes(root);
    verification = await loadVerification(root);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      findings.push(
        finding(
          "error",
          "invalid-configuration",
          error.message,
          "Correct the reported path and run noxroot doctor again.",
        ),
      );
    } else throw error;
  }

  const profile = await scanRepository(root, { sensitivePaths: config?.sensitivePaths ?? [] });
  if (!config) {
    findings.push(
      finding(
        "warning",
        "not-initialized",
        "No valid .noxroot/config.yml was found.",
        "Run noxroot preview, inspect the complete patch, then run noxroot init.",
      ),
    );
  } else {
    for (const configuredRoot of config.roots) {
      const resolved = path.resolve(root, configuredRoot);
      if (!isWithin(root, resolved) || !(await exists(resolved))) {
        findings.push(
          finding(
            "error",
            "missing-repository-root",
            `Configured repository root does not resolve inside the repository: ${configuredRoot}`,
            "Correct or remove the configured root.",
          ),
        );
      }
    }
    for (const entrypoint of config.entrypoints) {
      if (!profile.files.includes(entrypoint)) {
        findings.push(
          finding(
            "warning",
            "missing-entrypoint",
            `Configured agent entrypoint is missing: ${entrypoint}`,
            "Run noxroot sync --dry-run or remove the stale declaration.",
          ),
        );
      }
    }
    for (const [id, adapter] of Object.entries(config.agents.adapters)) {
      if (adapter.type === "command" && !(await commandAvailable(root, adapter.executable))) {
        findings.push(
          finding(
            "warning",
            "agent-adapter-unavailable",
            `Agent adapter ${id} executable is unavailable: ${adapter.executable}`,
            "Install it or select the manual adapter.",
          ),
        );
      }
    }
    if (config.modules.includes("verification") && !verification) {
      findings.push(
        finding(
          "warning",
          "verification-module-drift",
          "Verification is enabled but .noxroot/verification.yml is missing.",
          "Run noxroot sync --dry-run and confirm only authoritative commands.",
        ),
      );
    }
    if (
      config.modules.includes("browser-qa") &&
      !profile.evidence.some((item) => item.claim.includes("Playwright"))
    ) {
      findings.push(
        finding(
          "warning",
          "browser-module-drift",
          "Browser QA is enabled but compatible tooling was not detected.",
          "Configure an existing browser adapter or disable the module.",
        ),
      );
    }
    const defaultBytes = ["AGENTS.md", ".noxroot/config.yml", ".noxroot/knowledge/INDEX.md"].reduce(
      (total, file) => total + (profile.fileSizes[file] ?? 0),
      0,
    );
    if (defaultBytes > config.context.budgetBytes) {
      findings.push(
        finding(
          "warning",
          "default-context-oversized",
          `Default context is ${defaultBytes} bytes, above the ${config.context.budgetBytes}-byte budget.`,
          "Shorten entrypoints/indexes or raise the budget after review.",
        ),
      );
    }
    for (const file of profile.files.filter((item) => item.startsWith(".noxroot/knowledge/"))) {
      if ((profile.fileSizes[file] ?? 0) > config.context.documentWarningBytes) {
        findings.push(
          finding(
            "warning",
            "knowledge-document-oversized",
            `${file} exceeds the configured document warning size.`,
            "Consolidate or split it by stable concern without duplicating content.",
          ),
        );
      }
    }
    const knowledgeFiles = profile.files.filter(
      (item) => item.startsWith(".noxroot/knowledge/") && item !== ".noxroot/knowledge/INDEX.md",
    );
    let index = "";
    try {
      index = await readFile(path.join(root, ".noxroot", "knowledge", "INDEX.md"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const file of knowledgeFiles) {
      if (!index.includes(path.basename(file))) {
        findings.push(
          finding(
            "warning",
            "orphaned-knowledge",
            `${file} is not linked from the knowledge index.`,
            "Link it from INDEX.md, consolidate it, or archive it after review.",
          ),
        );
      }
      if ((profile.fileSizes[file] ?? 0) <= 256_000) {
        const content = await readFile(path.join(root, file), "utf8");
        const confirmed = /^Last confirmed:\s*(\d{4}-\d{2}-\d{2})\s*$/im.exec(content)?.[1];
        if (confirmed && Date.now() - Date.parse(confirmed) > 180 * 86_400_000) {
          findings.push(
            finding(
              "warning",
              "stale-knowledge",
              `${file} was last confirmed on ${confirmed}.`,
              "Revalidate it against source and tests or archive it.",
            ),
          );
        }
      }
    }
  }

  for (const command of verification?.commands ?? []) {
    const cwd = path.resolve(root, command.cwd);
    if (!isWithin(root, cwd)) {
      findings.push(
        finding(
          "error",
          "verification-cwd-escape",
          `Verification command ${command.id} has a working directory outside the repository.`,
          "Set cwd to a repository-relative directory.",
        ),
      );
    } else if (!(await exists(cwd))) {
      findings.push(
        finding(
          "error",
          "verification-cwd-missing",
          `Verification command ${command.id} working directory is missing: ${command.cwd}`,
          "Correct the working directory or remove the stale command.",
        ),
      );
    }
    if (!(await commandAvailable(root, command.executable))) {
      findings.push(
        finding(
          "warning",
          "verification-executable-unavailable",
          `Verification command ${command.id} executable is unavailable: ${command.executable}`,
          "Install it or confirm a portable executable and argument array.",
        ),
      );
    }
  }

  for (const route of routes?.routes ?? []) {
    for (const included of route.include.filter(
      (value) => !["*", "?", "[", "]"].some((character) => value.includes(character)),
    )) {
      if (!(await exists(path.resolve(root, included)))) {
        findings.push(
          finding(
            "warning",
            "missing-route-reference",
            `Route ${route.id} references a missing path: ${included}`,
            "Update the route or restore the referenced evidence.",
          ),
        );
      }
    }
  }
  if (
    config?.browser &&
    !verification?.commands.some((item) => item.id === config.browser?.verificationCommandId)
  ) {
    findings.push(
      finding(
        "error",
        "browser-command-missing",
        `Browser verification references unknown command: ${config.browser.verificationCommandId}`,
        "Confirm it in verification.yml or remove the browser configuration.",
      ),
    );
  }

  try {
    const runDirectory = path.join(await localStateRoot(root), "runs");
    const runFiles = (await readdir(runDirectory)).filter((file) => file.endsWith(".json"));
    if (config && runFiles.length > config.retention.maximumRuns) {
      findings.push(
        finding(
          "warning",
          "run-retention-exceeded",
          `${runFiles.length} local records exceed the configured maximum of ${config.retention.maximumRuns}.`,
          "Review completed evidence; preserve active or dirty worktrees.",
        ),
      );
    }
    for (const file of runFiles) {
      const absolute = path.join(runDirectory, file);
      const metadata = await stat(absolute);
      if (metadata.size > 256_000) continue;
      const record = JSON.parse(await readFile(absolute, "utf8")) as { status?: string };
      if (record.status === "running" && Date.now() - metadata.mtimeMs > 86_400_000) {
        findings.push(
          finding(
            "warning",
            "abandoned-run",
            `Local run appears abandoned: ${file}`,
            "Inspect its worktree and evidence before marking or removing it.",
          ),
        );
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (profile.suspectedSecrets.length > 0) {
    findings.push(
      finding(
        "info",
        "suspected-secrets-ignored",
        `${profile.suspectedSecrets.length} suspected secret path(s) were excluded.`,
        "Confirm sensitive path patterns without exposing contents.",
      ),
    );
  }
  if (profile.blockedSymlinks.length > 0) {
    findings.push(
      finding(
        "warning",
        "symlinks-not-inspected",
        `${profile.blockedSymlinks.length} symbolic link(s) were not followed.`,
        "Keep required evidence inside the repository or declare the limitation.",
      ),
    );
  }
  for (const reason of profile.stats.incompleteReasons) {
    findings.push(
      finding(
        "warning",
        "inspection-incomplete",
        reason,
        "Adjust bounded limits only after reviewing repository size and trust.",
      ),
    );
  }
  return {
    root,
    healthy: !findings.some((item) => item.severity === "error"),
    findings,
  };
}
