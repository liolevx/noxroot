// Explicit, opt-in network acceptance run. Never part of npm test or the shipped CLI.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
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

const source = path.resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(await readFile(path.join(import.meta.dirname, "corpus.json"), "utf8"));
const destination = process.argv[2];
const previous = process.argv[3] ? JSON.parse(await readFile(process.argv[3], "utf8")) : undefined;
if (!destination || process.platform === "win32")
  throw new Error("Run in WSL/Linux and supply an output JSON path.");
const scratch = await mkdtemp(path.join(tmpdir(), "noxroot-thirty-"));
const env = {
  ...process.env,
  NO_COLOR: "1",
  GIT_TERMINAL_PROMPT: "0",
  npm_config_cache: path.join(scratch, "npm-cache"),
};
function run(executable, args, cwd = source, timeout = 120_000) {
  const started = performance.now();
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
    ms: Math.round(performance.now() - started),
  };
}
function required(executable, args, cwd, timeout) {
  const result = run(executable, args, cwd, timeout);
  if (result.code !== 0)
    throw new Error(`${executable} failed (${result.code}): ${result.stderr.slice(0, 1500)}`);
  return result.stdout;
}
function git(args, cwd) {
  return required(
    "git",
    ["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", ...args],
    cwd,
  );
}
async function tree(root) {
  const entries = {};
  async function visit(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const name = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) entries[name] = `link:${await readlink(path.join(root, name))}`;
      else if (entry.isDirectory()) await visit(name);
      else if (entry.isFile())
        entries[name] = createHash("sha256")
          .update(await readFile(path.join(root, name)))
          .digest("hex");
    }
  }
  await visit("");
  return entries;
}
const same = (a, b) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const report = {
  candidate: git(["rev-parse", "HEAD"]).trim(),
  startedAt: new Date().toISOString(),
  method:
    "Sequential read-only preview/context, disposable init/sync, and no-authorized-checks lifecycle smoke. No application dependencies installed, native project commands executed, agent calls, or commits to tested repositories.",
  results: [],
  cleanup: false,
};
let cli;
function invoke(root, args) {
  const result = run(process.execPath, [cli, ...args, "--root", root, "--json"]);
  try {
    return { ...result, value: JSON.parse(result.stdout) };
  } catch {
    return { ...result, value: null };
  }
}
function demand(value, message) {
  if (!value) throw new Error(message);
}

try {
  const packed = JSON.parse(
    required("npm", ["pack", "--pack-destination", scratch, "--json", "--ignore-scripts"]),
  )[0];
  report.package = {
    size: packed.size,
    unpackedSize: packed.unpackedSize,
    sha256: createHash("sha256")
      .update(await readFile(path.join(scratch, packed.filename)))
      .digest("hex"),
  };
  const tarballs = [path.join(scratch, packed.filename)];
  for (const dependency of ["commander", "yaml", "zod"]) {
    const info = JSON.parse(
      required("npm", [
        "pack",
        path.join(source, "node_modules", dependency),
        "--pack-destination",
        scratch,
        "--json",
        "--ignore-scripts",
      ]),
    )[0];
    tarballs.push(path.join(scratch, info.filename));
  }
  const install = path.join(scratch, "installed");
  await mkdir(install);
  await writeFile(path.join(install, "package.json"), '{"name":"acceptance-only","private":true}');
  required(
    "npm",
    ["install", ...tarballs, "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
    install,
  );
  cli = path.join(install, "node_modules/noxroot/dist/cli.js");
  for (const [index, spec] of manifest.entries()) {
    const root = path.join(scratch, `repo-${index}`);
    const row = { ...spec, failures: [] };
    try {
      git([
        "clone",
        "--depth",
        "1",
        "--single-branch",
        `https://github.com/${spec.repo}.git`,
        root,
      ]);
      const pinned = previous?.results.find((item) => item.repo === spec.repo)?.revision;
      if (pinned) {
        git(["fetch", "--depth", "1", "origin", pinned], root);
        git(["checkout", "--detach", pinned], root);
      }
      row.revision = git(["rev-parse", "HEAD"], root).trim();
      const before = await tree(root);
      const first = invoke(root, ["preview"]);
      demand(
        first.code === 0 && first.value?.kind === "preview",
        "preview did not return valid JSON",
      );
      const preview = first.value;
      const again = invoke(root, ["preview"]);
      const context = invoke(root, ["context", spec.task]);
      row.readOnly = same(before, await tree(root));
      demand(row.readOnly, "read-only commands changed repository files");
      row.previewMs = first.ms;
      row.files = preview.profile.files.length;
      row.limits = preview.profile.stats.incompleteReasons;
      row.initializationAllowed = preview.initializationAllowed;
      row.conflicts = preview.conflicts;
      row.capabilities = preview.capabilities;
      row.proposals = preview.proposedFiles.map(({ path, action }) => ({ path, action }));
      row.growth = preview.setupImpact;
      row.commands = preview.profile.candidateCommands;
      row.deterministic =
        JSON.stringify(preview.proposedFiles) === JSON.stringify(again.value?.proposedFiles) &&
        JSON.stringify(preview.capabilities) === JSON.stringify(again.value?.capabilities);
      if (!row.limits.length) demand(row.deterministic, "complete repeated previews differ");
      demand(context.value?.budget, "context did not return a task package");
      row.context = {
        ms: context.ms,
        confidence: context.value.confidence,
        budget: context.value.budget,
        selected: context.value.selected.map((item) => item.path),
        owners: context.value.likelyOwningSource,
        tests: context.value.likelyTests,
        unknowns: context.value.unknowns,
      };
      demand(
        row.context.budget.selectedBytes <= row.context.budget.maximumBytes,
        "context exceeded its byte budget",
      );
      const initialized = invoke(root, ["init", "--yes"]);
      if (!preview.initializationAllowed) {
        row.init = "refused";
        demand(
          initialized.code !== 0 && same(before, await tree(root)),
          "refused init wrote files or succeeded",
        );
      } else {
        demand(initialized.code === 0, `init failed: ${initialized.stderr}`);
        const after = await tree(root);
        const permitted = new Set(row.proposals.map((item) => item.path));
        row.changedPaths = Object.keys({ ...before, ...after }).filter(
          (file) => before[file] !== after[file],
        );
        demand(
          row.changedPaths.every((file) => permitted.has(file)),
          "init changed a non-proposed path",
        );
        const secondInit = invoke(root, ["init", "--yes"]);
        row.idempotent = secondInit.code === 0 && same(after, await tree(root));
        demand(
          row.idempotent,
          secondInit.code !== 0
            ? `second init failed: ${secondInit.stderr.slice(0, 500)}`
            : "second init changed setup",
        );
        const sync = invoke(root, ["sync", "--dry-run"]);
        row.syncProposals = sync.value?.preview?.proposedFiles?.length ?? null;
        row.init = "applied-only-proposed-files";
        // Explicit zero-execution policy for the breadth lane, NOT an app verification pass.
        await mkdir(path.join(root, ".noxroot"), { recursive: true });
        await writeFile(path.join(root, ".noxroot/verification.yml"), "version: 1\ncommands: []\n");
        await appendFile(path.join(root, ".git/info/exclude"), "\n/.noxroot/\n/AGENTS.md\n");
        const dirty = git(["status", "--porcelain"], root).trim();
        if (dirty)
          row.lifecycle = {
            skipped:
              "Tracked setup edits require a commit; this test does not commit to external repositories.",
          };
        else {
          const started = invoke(root, ["start", spec.task]);
          if (!started.value?.record) row.lifecycle = { skipped: started.value ?? started.stderr };
          else {
            const continued = invoke(root, ["start", spec.task]);
            demand(
              continued.value?.continued === true &&
                continued.value.record.id === started.value.record.id,
              "duplicate task on continuation",
            );
            const noChange = invoke(root, ["finish"]);
            demand(
              noChange.value?.record?.status === "blocked",
              "no-change finish should be blocked",
            );
            const editable = Object.keys(before).find(
              (file) => /^readme(?:\.md|\.rst)?$/i.test(file) && !before[file].startsWith("link:"),
            );
            if (!editable)
              row.lifecycle = {
                continued: true,
                noChange: "blocked",
                skipped: "No root README for the harmless changed-diff probe.",
              };
            else {
              await appendFile(path.join(root, editable), "\n");
              const memoryBefore = await tree(path.join(root, ".noxroot"));
              const finished = invoke(root, ["finish"]);
              demand(
                finished.value?.record?.status === "incomplete",
                "no-authorized-checks finish should be incomplete, never approved",
              );
              demand(
                finished.value.record.id === started.value.record.id,
                "finish did not infer the active task",
              );
              demand(
                same(memoryBefore, await tree(path.join(root, ".noxroot"))),
                "incomplete finish grew project documentation",
              );
              row.lifecycle = {
                continued: true,
                noChange: "blocked",
                changedDiff: "incomplete",
                finishInferred: true,
                documentationUnchanged: true,
                agentCalls: finished.value.record.calls.length,
              };
            }
          }
        }
      }
    } catch (error) {
      row.failures.push(error.message);
    } finally {
      // Each target is constructed beneath this process's private mkdtemp root.
      demand(path.dirname(root) === scratch, "unsafe cleanup target");
      await rm(root, { recursive: true, force: true });
    }
    report.results.push(row);
    console.log(
      `${index + 1}/30 ${spec.repo}: ${row.failures.length ? row.failures.join("; ") : "checks complete"}`,
    );
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
  report.cleanup = true;
  report.finishedAt = new Date().toISOString();
  await mkdir(path.dirname(path.resolve(destination)), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
}
if (report.results.length !== 30 || report.results.some((row) => row.failures.length))
  process.exitCode = 1;
