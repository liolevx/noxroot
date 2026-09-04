// Opt-in acceptance, not part of CI. Requires an existing Codex login and built dist/.
// Uses three real sessions in one synthetic repository; never changes an external project.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const source = path.resolve(import.meta.dirname, "../..");
const scratch = await mkdtemp(path.join(tmpdir(), "noxroot-lifecycle-"));
const root = path.join(scratch, "project-dashboard");
const env = {
  ...process.env,
  npm_config_cache: path.join(scratch, "npm-cache"),
  npm_config_audit: "false",
  npm_config_fund: "false",
};
delete env.OPENAI_API_KEY;
delete env.CODEX_API_KEY;
const report = { phase: "setup", sourceCommit: "", package: {}, checks: {}, sessions: [], root };
async function save() {
  await writeFile(path.join(scratch, "report.json"), JSON.stringify(report, null, 2));
}
function run(bin, args, cwd = root, allowFailure = false) {
  const result = spawnSync(bin, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 16000000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure)
    throw new Error(`${bin} failed (${result.status}): ${result.stderr}`);
  return result;
}
async function files(directory = root, prefix = "") {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relative = prefix + entry.name;
    if ([".git", "node_modules"].includes(entry.name) || relative === ".noxroot/local") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await files(absolute, `${relative}/`));
    else if (entry.isFile())
      result[relative] = createHash("sha256")
        .update(await readFile(absolute))
        .digest("hex");
  }
  return result;
}
async function records() {
  const directory = path.join(root, ".noxroot/local/runs");
  const names = await readdir(directory).catch(() => []);
  return Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map(async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8"))),
  );
}
async function agent(label, prompt) {
  report.phase = label;
  await save();
  console.log(`\nCodex: ${label} (fresh session, workspace-write sandbox)`);
  const evidence = { label, exitCode: null, commands: [], summary: "" };
  const args = [
    "-a",
    "never",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox",
    "workspace-write",
    "--json",
    "-C",
    root,
    `${prompt}\nWork only in this disposable repository. Do not commit, push, publish, install dependencies, read credentials, access unrelated directories, or use additional agents.`,
  ];
  await new Promise((resolve, reject) => {
    const child = spawn("codex", args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let pending = "";
    let diagnostic = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 300000);
    child.stderr.on("data", (data) => {
      diagnostic = (diagnostic + data).slice(-2000);
    });
    child.stdout.on("data", (data) => {
      pending += data;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const item = event.item;
        if (event.type === "item.completed" && item?.type === "command_execution") {
          // Retain only bounded product-command evidence, not raw agent transcripts.
          if (/noxroot|npm test/.test(item.command))
            evidence.commands.push({
              command: item.command,
              exitCode: item.exit_code,
              output: item.aggregated_output?.slice(0, 12000),
            });
        }
        if (event.type === "item.completed" && item?.type === "agent_message")
          evidence.summary = item.text;
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      evidence.exitCode = code;
      if (code !== 0) reject(new Error(`Codex ${label} exited ${code}: ${diagnostic}`));
      else resolve();
    });
  });
  evidence.records = (await records()).map((r) => ({
    id: r.id,
    task: r.task,
    status: r.status,
    baseline: r.baseline,
  }));
  report.sessions.push(evidence);
  await save();
  console.log(evidence.summary);
}

console.log(`Acceptance workspace: ${scratch}`);
try {
  await mkdir(root);
  report.sourceCommit = run("git", ["rev-parse", "HEAD"], source).stdout.trim();
  const packages = [];
  for (const directory of [
    source,
    ...["commander", "yaml", "zod"].map((name) => path.join(source, "node_modules", name)),
  ]) {
    const packed = JSON.parse(
      run(
        "npm",
        ["pack", directory, "--pack-destination", scratch, "--json", "--ignore-scripts"],
        scratch,
      ).stdout,
    )[0];
    packages.push(path.join(scratch, packed.filename));
    if (directory === source)
      report.package = {
        size: packed.size,
        unpackedSize: packed.unpackedSize,
        integrity: packed.integrity,
      };
  }
  for (const directory of ["src", "tests", "docs"]) await mkdir(path.join(root, directory));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "project-dashboard-demo",
        private: true,
        type: "module",
        scripts: { test: "node --test tests/*.test.mjs" },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
  await writeFile(
    path.join(root, "docs/architecture.md"),
    "# Navigation\n\nProject filters belong in the URL query string. Preserve that query when building return links. Do not add localStorage or a parallel state store.\n",
  );
  await writeFile(
    path.join(root, "src/project-return-url.mjs"),
    'export function projectReturnUrl(listUrl) {\n  const url = new URL(listUrl, "https://dashboard.example");\n  return url.pathname;\n}\n',
  );
  await writeFile(
    path.join(root, "tests/project-return-url.test.mjs"),
    'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { projectReturnUrl } from "../src/project-return-url.mjs";\ntest("returns the project-list path", () => {\n  assert.equal(projectReturnUrl("/projects"), "/projects");\n});\n',
  );
  run("npm", [
    "install",
    "--offline",
    "--no-save",
    "--package-lock=false",
    "--ignore-scripts",
    ...packages,
  ]);
  env.npm_config_cache = path.join(root, "node_modules/.cache/npm");
  env.npm_config_offline = "true";
  run("git", ["init", "-b", "agent/live-demo"]);
  run("git", ["config", "user.name", "Noxroot Demo"]);
  run("git", ["config", "user.email", "demo@example.invalid"]);
  const cli = path.join(root, "node_modules/noxroot/dist/cli.js");
  const nox = (...args) => run("node", [cli, ...args]);
  const before = await files();
  report.preview = nox("preview", "--json").stdout;
  report.checks.previewReadOnly = JSON.stringify(before) === JSON.stringify(await files());
  nox("init", "--yes", "--json");
  const firstInit = await files();
  nox("init", "--yes", "--json");
  report.checks.initIdempotent = JSON.stringify(firstInit) === JSON.stringify(await files());
  // Explicit fixture approval, not a claim that discovered scripts are trusted automatically.
  await writeFile(
    path.join(root, ".noxroot/verification.yml"),
    'version: 1\ncommands:\n  - id: unit-tests\n    executable: npm\n    args: [test]\n    cwd: .\n    timeoutMs: 30000\n    appliesTo: ["src/**", "tests/**"]\n',
  );
  run("git", ["add", "."]);
  run("git", ["commit", "-m", "Synthetic baseline with approved one-time setup"]);
  report.initialFiles = await files();
  console.log(
    "Packed CLI installed. Preview unchanged; setup completed once. Ready for everyday use.",
  );
  await agent(
    "question",
    "What does projectReturnUrl do, and where are this repository's navigation conventions documented? Explain briefly without changing anything.",
  );
  report.checks.questionNoTask = (await records()).length === 0;
  report.checks.questionNoChanges =
    JSON.stringify(report.initialFiles) === JSON.stringify(await files());
  await agent(
    "regression",
    "Preserve project filters on back navigation. First add a regression test for /projects?status=active&sort=name losing its query string. Run the test to reproduce the bug, then stop before implementing the fix; we will continue this same change in a new conversation.",
  );
  const first = await records();
  report.checks.firstTaskCount = first.length;
  report.checks.regressionExit = run("npm", ["test"], root, true).status;
  await agent(
    "continuation",
    "Preserve project filters on back navigation. Continue the unfinished change already in this repository. Inspect the existing test and local task state, implement the smallest fix consistent with the documented convention, verify it, and report the result.",
  );
  const final = await records();
  report.checks.finalTaskCount = final.length;
  report.checks.sameTask =
    first.length === 1 &&
    final.length === 1 &&
    first[0].id === final[0].id &&
    first[0].baseline.revision === final[0].baseline.revision;
  report.checks.completed = final.length === 1 && final[0].status === "completed";
  report.checks.finalTestExit = run("npm", ["test"], root, true).status;
  report.checks.diffCheckExit = run("git", ["diff", "--check"], root, true).status;
  report.finalFiles = await files();
  report.checks.documentationChanged = Object.keys(report.finalFiles).filter(
    (name) =>
      (name.startsWith("docs/") || name.startsWith(".noxroot/knowledge/")) &&
      report.finalFiles[name] !== report.initialFiles[name],
  );
  report.finalRecords = final;
  report.finalDiff = run("git", ["diff"]).stdout;
  report.context = nox(
    "context",
    "Preserve project filters on back navigation",
    "--no-color",
  ).stdout;
  report.status = nox("status", "--json").stdout;
  report.gitStatus = run("git", ["status", "--short"]).stdout;
  report.phase = "finished";
  await save();
  console.log("\nAcceptance:", JSON.stringify(report.checks, null, 2));
  console.log(`Evidence: ${path.join(scratch, "report.json")}`);
  if (!report.checks.sameTask || !report.checks.completed || report.checks.finalTestExit !== 0)
    process.exitCode = 1;
} catch (error) {
  report.phase = "blocked";
  report.error = error.message;
  await save();
  console.error(error.message);
  process.exitCode = 1;
}
// Preserve the dirty synthetic repository for inspection. The operator removes installed
// dependencies and archives the small recovery evidence after evaluating the result.
