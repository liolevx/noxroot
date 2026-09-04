// Opt-in read-only breadth probe. This is NOT an autonomous workflow or value benchmark.
// Run in WSL: node tests/acceptance/adoption-corpus.mjs OUTPUT.json [PREVIOUS.json]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const manifest = JSON.parse(await readFile(new URL("./adoption-corpus.json", import.meta.url)));
const previousCorpus = JSON.parse(await readFile(new URL("./corpus.json", import.meta.url)));
const destination = process.argv[2];
if (!destination || process.platform === "win32")
  throw new Error("Use WSL/Linux and supply OUTPUT.json.");
const prior = process.argv[3] ? JSON.parse(await readFile(process.argv[3], "utf8")) : undefined;
if (manifest.some((spec) => previousCorpus.some((old) => old.repo === spec.repo)))
  throw new Error("Manifest overlaps the recorded thirty-repository corpus.");
const scratch = await mkdtemp(path.join(tmpdir(), "noxroot-adoption-"));
const env = {
  ...process.env,
  NO_COLOR: "1",
  COLUMNS: "80",
  GIT_TERMINAL_PROMPT: "0",
  npm_config_cache: path.join(scratch, "npm-cache"),
};
const report = {
  startedAt: new Date().toISOString(),
  package: "noxroot@0.1.0",
  scope:
    "Published-package read-only preview/context only. No init, commits, dependency installation in target repos, agent calls, or native project checks. Distinct from the recorded thirty-repository manifest; earlier unrecorded coverage is not asserted.",
  results: [],
  retained: [],
  scratch,
  cleanup: false,
};

function run(executable, args, cwd = scratch, timeout = 120_000) {
  const start = performance.now();
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 16_000_000,
    shell: false,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
    ms: Math.round(performance.now() - start),
  };
}
function must(result) {
  if (result.code !== 0)
    throw new Error(`Command failed (${result.code}): ${result.stderr.slice(0, 800)}`);
  return result.stdout;
}
function git(args, cwd) {
  return must(
    run("git", ["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", ...args], cwd),
  );
}
async function snapshot(root) {
  const hashes = {};
  async function visit(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const name = path.posix.join(relative, entry.name);
      const file = path.join(root, name);
      if (entry.isSymbolicLink()) hashes[name] = `symlink:${await readlink(file)}`;
      else if (entry.isDirectory()) await visit(name);
      else if (entry.isFile())
        hashes[name] = createHash("sha256")
          .update(await readFile(file))
          .digest("hex");
    }
  }
  await visit("");
  return hashes;
}
const equal = (a, b) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
let cli;
function invoke(root, args, json = true) {
  const result = run(process.execPath, [cli, ...args, "--root", root, ...(json ? ["--json"] : [])]);
  if (!json) return result;
  return { ...result, value: JSON.parse(must(result)) };
}
async function removeChild(target) {
  if (path.dirname(target) !== scratch || (await lstat(target)).isSymbolicLink())
    throw new Error("Unsafe cleanup target");
  await rm(target, { recursive: true });
}

try {
  const install = path.join(scratch, "installed");
  await mkdir(install);
  await writeFile(
    path.join(install, "package.json"),
    '{"name":"noxroot-adoption-probe","private":true}',
  );
  must(
    run(
      "npm",
      [
        "install",
        "--save-exact",
        "noxroot@0.1.0",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org/",
      ],
      install,
    ),
  );
  const lock = JSON.parse(await readFile(path.join(install, "package-lock.json"), "utf8"));
  report.integrity = lock.packages["node_modules/noxroot"].integrity;
  cli = path.join(install, "node_modules/noxroot/dist/cli.js");
  for (const [index, spec] of manifest.entries()) {
    const root = path.join(scratch, `repo-${index}`);
    const row = { ...spec, failures: [] };
    let baseline;
    try {
      git([
        "clone",
        "--depth",
        "1",
        "--single-branch",
        `https://github.com/${spec.repo}.git`,
        root,
      ]);
      const pinned = prior?.results.find((entry) => entry.repo === spec.repo)?.revision;
      if (prior && !pinned)
        throw new Error("Rerun requires a recorded revision for every repository.");
      if (pinned) {
        git(["fetch", "--depth", "1", "origin", pinned], root);
        git(["checkout", "--detach", pinned], root);
      }
      row.revision = git(["rev-parse", "HEAD"], root).trim();
      baseline = await snapshot(root);
      row.totalFiles = Object.keys(baseline).length;
      row.existingInstructionPaths = Object.keys(baseline).filter((name) =>
        /(^|\/)(AGENTS\.md|CLAUDE\.md|copilot-instructions\.md)$|(^|\/)\.cursor\/rules\//.test(
          name,
        ),
      );
      const first = invoke(root, ["preview"]);
      const second = invoke(root, ["preview"]);
      const context = invoke(root, ["context", spec.task]);
      const human = invoke(root, ["context", spec.task], false);
      must(human);
      row.preview = {
        ms: first.ms,
        initializationAllowed: first.value.initializationAllowed,
        conflicts: first.value.conflicts,
        capabilities: first.value.capabilities,
        growth: first.value.setupImpact,
        limits: first.value.profile.stats.incompleteReasons,
        commands: first.value.profile.candidateCommands,
        proposals: first.value.proposedFiles.map(({ path, action }) => ({ path, action })),
      };
      row.repeatableProposal =
        JSON.stringify(first.value.proposedFiles) === JSON.stringify(second.value.proposedFiles);
      row.context = {
        ms: context.ms,
        confidence: context.value.confidence,
        budget: context.value.budget,
        selected: context.value.selected.map((entry) => entry.path),
        owners: context.value.likelyOwningSource,
        tests: context.value.likelyTests,
        unknowns: context.value.unknowns,
      };
      row.terminal = {
        lines: human.stdout.trimEnd().split("\n").length,
        bytes: Buffer.byteLength(human.stdout),
        text: human.stdout,
      };
      if (row.context.budget.selectedBytes > row.context.budget.maximumBytes)
        row.failures.push("Context exceeds byte budget");
      if (!row.preview.limits.length && !row.repeatableProposal)
        row.failures.push("Complete repeated preview proposals differ");
    } catch (error) {
      row.failures.push(error.message);
    } finally {
      try {
        const clean = !git(["status", "--porcelain", "--untracked-files=all"], root).trim();
        row.readOnly = Boolean(baseline && clean && equal(baseline, await snapshot(root)));
        if (row.readOnly) await removeChild(root);
        else {
          row.failures.push("Preserved checkout: read-only integrity not established");
          report.retained.push(root);
        }
      } catch (error) {
        row.failures.push(`Cleanup stopped: ${error.message}`);
        report.retained.push(root);
      }
    }
    report.results.push(row);
    await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      `${index + 1}/${manifest.length} ${spec.repo}: ${row.failures.length ? row.failures.join("; ") : "read-only checks complete"}`,
    );
  }
} finally {
  // Remove only owned install/cache and clean verified checkouts. Preserve any uncertain repo.
  for (const name of ["installed", "npm-cache"]) {
    const target = path.join(scratch, name);
    try {
      await removeChild(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if ((await readdir(scratch)).length === 0) {
    await rm(scratch, { recursive: true });
    report.cleanup = true;
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
}
if (report.results.length !== manifest.length || report.results.some((row) => row.failures.length))
  process.exitCode = 1;
