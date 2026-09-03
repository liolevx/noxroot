// Opt-in native test lane, using inspected upstream tests and disposable checkouts.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
const source = path.resolve(import.meta.dirname, "../..");
const destination = process.argv[2];
if (!destination || process.platform === "win32") throw Error("Use WSL/Linux and an output path.");
const scratch = await mkdtemp("/tmp/noxroot-native-");
const previous = JSON.parse(
  await readFile(path.join(import.meta.dirname, "results-2026-09-03.json"), "utf8"),
);
const env = Object.fromEntries(
  ["PATH", "HOME", "LANG", "TMPDIR"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
);
env.npm_config_cache = path.join(scratch, "npm-cache");
env.GIT_TERMINAL_PROMPT = "0";
function run(executable, args, cwd = source) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 8_000_000,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}
function required(executable, args, cwd) {
  const r = run(executable, args, cwd);
  if (r.code !== 0) throw Error(`${executable}: ${(r.stderr || r.stdout).slice(-2000)}`);
  return r.stdout;
}
function git(args, cwd) {
  return required(
    "git",
    ["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", ...args],
    cwd,
  );
}
let cli;
function invoke(root, args) {
  const r = run(process.execPath, [cli, ...args, "--root", root, "--json"]);
  try {
    return { ...r, value: JSON.parse(r.stdout) };
  } catch {
    throw Error(r.stderr || r.stdout);
  }
}
const report = {
  candidate: git(["rev-parse", "HEAD"]).trim(),
  method:
    "Native upstream tests plus one added regression test, not an autonomous feature implementation or independent review.",
  results: [],
  cleanup: false,
};
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
    const p = JSON.parse(
      required("npm", [
        "pack",
        path.join(source, "node_modules", dependency),
        "--pack-destination",
        scratch,
        "--json",
        "--ignore-scripts",
      ]),
    )[0];
    tarballs.push(path.join(scratch, p.filename));
  }
  const installed = path.join(scratch, "installed");
  await mkdir(installed);
  await writeFile(path.join(installed, "package.json"), '{"name":"native-only","private":true}');
  required(
    "npm",
    ["install", ...tarballs, "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
    installed,
  );
  cli = path.join(installed, "node_modules/noxroot/dist/cli.js");
  for (const repo of ["lukeed/kleur", "pallets/itsdangerous"]) {
    const revision = previous.results.find((r) => r.repo === repo).revision;
    const root = path.join(scratch, repo.split("/")[1]);
    const row = { repo, revision };
    try {
      git(["clone", "--depth", "1", `https://github.com/${repo}.git`, root], scratch);
      git(["fetch", "--depth", "1", "origin", revision], root);
      git(["checkout", "--detach", revision], root);
      const preview = invoke(root, ["preview"]).value;
      row.discoveredCommands = preview.profile.candidateCommands;
      if (!preview.initializationAllowed) throw Error("Initialization refused");
      if (invoke(root, ["init", "--yes"]).code !== 0) throw Error("Initialization failed");
      await appendFile(path.join(root, ".git/info/exclude"), "\n/.noxroot/\n/AGENTS.md\n/.venv/\n");
      let executable, args, target, addition;
      if (repo.endsWith("kleur")) {
        required(
          "npm",
          ["install", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund"],
          root,
        );
        row.dependencies = JSON.parse(required("npm", ["ls", "--json"], root)).dependencies;
        executable = "npm";
        args = ["run", "test"];
        target = "test/index.js";
        addition =
          "\ntest('acceptance: disabled styling preserves Unicode', () => {\n  kleur.enabled = false;\n  assert.is(kleur.red('café'), 'café');\n});\n";
      } else {
        required("python3", ["-m", "venv", path.join(root, ".venv")], root);
        executable = path.join(root, ".venv/bin/python");
        required(
          executable,
          ["-m", "pip", "install", "--no-cache-dir", "pytest", "freezegun", "flit_core<4"],
          root,
        );
        required(
          executable,
          ["-m", "pip", "install", "--no-cache-dir", "--no-build-isolation", "-e", "."],
          root,
        );
        row.dependencies = JSON.parse(
          required(executable, ["-m", "pip", "list", "--format=json"], root),
        );
        args = ["-m", "pytest", "-q"];
        target = "tests/test_itsdangerous/test_signer.py";
        addition =
          "\n\ndef test_unicode_round_trip_acceptance():\n    signer = Signer('acceptance-fixture-only')\n    value = 'café'.encode('utf-8')\n    assert signer.unsign(signer.sign(value)) == value\n";
      }
      row.approvedCommand = {
        id: "native-tests",
        executable,
        args,
        cwd: ".",
        timeoutMs: 120000,
        appliesTo: ["**/*"],
      };
      await writeFile(
        path.join(root, ".noxroot/verification.yml"),
        JSON.stringify({ version: 1, commands: [row.approvedCommand] }),
      );
      if (git(["status", "--porcelain"], root).trim())
        throw Error("Setup left tracked changes; no external repository commits allowed");
      row.baseline = run(executable, args, root);
      row.baseline.stdout = row.baseline.stdout.slice(-2000);
      row.baseline.stderr = row.baseline.stderr.slice(-2000);
      const task = repo.endsWith("kleur")
        ? "test disabled styling preserves Unicode"
        : "test signer Unicode round trip";
      const started = invoke(root, ["start", task]);
      if (!started.value.record) throw Error("Start refused");
      row.context = {
        selected: started.value.context.selected.map((f) => f.path),
        budget: started.value.context.budget,
      };
      const original = await readFile(path.join(root, target), "utf8");
      await writeFile(
        path.join(root, target),
        repo.endsWith("kleur")
          ? original.replace("test.run();", addition + "\ntest.run();")
          : original + addition,
      );
      const continued = invoke(root, ["start", task]);
      row.continued =
        continued.value.continued === true && continued.value.record.id === started.value.record.id;
      const finished = invoke(root, ["finish"]);
      row.status = finished.value.record?.status;
      row.finishInferred = finished.value.record?.id === started.value.record.id;
      row.completion = finished.value.completion;
      row.learning = finished.value.learning;
      row.verification = finished.value.record?.verification;
      row.changedFiles = git(["diff", "--name-only"], root).trim().split("\n");
      row.nextContext = invoke(root, ["context", task]).value.selected.map((f) => f.path);
      console.log(`${repo}: baseline ${row.baseline.code}, finish ${row.status}`);
    } catch (error) {
      row.error = error.message;
      console.log(`${repo}: ${row.error}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    report.results.push(row);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
  report.cleanup = true;
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
}
