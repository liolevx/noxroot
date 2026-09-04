// Opt-in follow-up to legacy-workflows.mjs. Uses the user's existing Codex login.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const scratch = path.resolve(process.argv[2] ?? ".");
if (process.platform === "win32" || !/^\/tmp\/noxroot-legacy-acceptance-[\w-]+$/.test(scratch))
  throw Error("Use the prepared Linux legacy acceptance directory.");
const name = process.argv[3] ?? "live-legacy";
if (!/^live-legacy(?:-[a-z0-9]+)?$/.test(name)) throw Error("Use a live-legacy-* fixture name.");
const root = path.join(scratch, name);
const env = {
  ...process.env,
  npm_config_offline: "true",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_cache: path.join(root, "node_modules/.cache/npm"),
};
delete env.OPENAI_API_KEY;
delete env.CODEX_API_KEY;
function run(bin, args, cwd = root) {
  const r = spawnSync(bin, args, { cwd, env, encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout;
}
run(
  "git",
  [
    "-c",
    "core.hooksPath=/dev/null",
    "clone",
    "--no-hardlinks",
    path.join(scratch, "legacy-project"),
    root,
  ],
  scratch,
);
await appendFile(path.join(root, ".git/info/exclude"), "\n/node_modules/\n");
const packages = (await readdir(scratch))
  .filter((p) => p.endsWith(".tgz"))
  .map((p) => path.join(scratch, p));
packages.push(path.join(scratch, "current-install/noxroot-0.1.0.tgz"));
run("npm", [
  "install",
  "--offline",
  "--no-save",
  "--package-lock=false",
  "--ignore-scripts",
  ...packages,
]);
const task = "test normalization preserves internal spaces";
const oldCli = path.join(scratch, "old-install/node_modules/noxroot/dist/cli.js");
const currentCli = path.join(root, "node_modules/noxroot/dist/cli.js");
const started = JSON.parse(run("node", [oldCli, "start", task, "--json"]));
run("node", [currentCli, "sync", "--yes", "--json"]);
const beforeDiff = run("git", ["diff"]);
const beforeStatus = run("git", ["status", "--porcelain"]);
const beforeRecord = await readFile(started.recordPath, "utf8");
const report = { root, taskId: started.record.id, commands: [], summary: "", exitCode: null };
await new Promise((resolve, reject) => {
  const prompt =
    "Continue the unfinished task to test normalization preserves internal spaces. Add a regression for surrounding whitespace while keeping two internal spaces. Follow this repository's instructions and report what you could complete. Work only here. Do not commit, push, publish, install dependencies, read credentials, access unrelated projects, or use additional agents.";
  const child = spawn(
    "codex",
    [
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
      prompt,
    ],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let pending = "",
    diagnostic = "";
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
      if (event.type !== "item.completed") continue;
      const item = event.item;
      if (item?.type === "command_execution" && /noxroot/.test(item.command))
        report.commands.push({
          command: item.command,
          exitCode: item.exit_code,
          output: item.aggregated_output?.slice(0, 6000),
        });
      if (item?.type === "agent_message") report.summary = item.text;
    }
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    report.exitCode = code;
    if (code !== 0) reject(Error(`Codex exited ${code}: ${diagnostic}`));
    else resolve();
  });
});
report.checks = {
  noEdits:
    run("git", ["diff"]) === beforeDiff && run("git", ["status", "--porcelain"]) === beforeStatus,
  recordUnchanged: (await readFile(started.recordPath, "utf8")) === beforeRecord,
  noSecondStore: !(await readdir(path.join(root, ".noxroot"))).includes("local"),
  startDenied: report.commands.some(
    (c) =>
      /start/.test(c.command) && c.exitCode === 3 && /Task state is not writable/.test(c.output),
  ),
};
await writeFile(path.join(scratch, `${name}-denial.json`), JSON.stringify(report, null, 2) + "\n");
console.log(report.summary);
console.log(JSON.stringify(report.checks, null, 2));
assert.ok(
  Object.values(report.checks).every(Boolean),
  "Live legacy denial acceptance failed; inspect retained evidence.",
);
