// Bounded acceptance fixture; optional real agent sessions, never a productivity benchmark.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, lstat, cp } from "node:fs/promises";
import path from "node:path";
import { environment, execute, git, save } from "./workflow-support.mjs";
import { freshAgent } from "./p1-p2-agent.mjs";
import { records } from "./workflow-support.mjs";
import { recover } from "./p1-p2-recover.mjs";
import { checkpoint } from "./p1-p2-checkpoint.mjs";

const [mode, scratch] = process.argv.slice(2);
if (mode === "prepare") {
  const root = await mkdtemp("/tmp/noxroot-p1-p2-live-");
  await save(path.join(root, "state.json"), { root, owned: [], sessions: [] });
  const url =
    "https://github.com/colinsurprenant/director/releases/download/v1.14.0/director_v1.14.0_linux_amd64.tar.gz";
  const response = await fetch(url);
  assert.ok(response.ok);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256, "ffca024163f23a770ac99268a01226adf0621717ceb4236dd6d7e560f0c275cc");
  const archive = path.join(root, "director.tar.gz");
  await writeFile(archive, bytes);
  const members = execute("tar", ["-tzf", archive], root).stdout.trim().split("\n");
  assert.ok(members.includes("director"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  execute("tar", ["-xzf", archive, "-C", bin, "director"], root);
  assert.ok((await lstat(path.join(bin, "director"))).isFile());
  const state = {
    root,
    director: path.join(bin, "director"),
    directorSource: { url, sha256 },
    owned: ["bin", "director.tar.gz"],
    sessions: [],
  };
  await save(path.join(root, "state.json"), state);
  console.log(root);
  for (const args of [["--help"], ["adopt", "--help"], ["emit", "--help"], ["render", "--help"]])
    console.log(
      execute(state.director, args, root, {
        env: { ...environment, DIRECTOR_HUB: path.join(root, "hub") },
        allowFailure: true,
      }).stdout.slice(0, 5000),
    );
} else {
  assert.match(scratch ?? "", /^\/tmp\/noxroot-p1-p2-live-[\w-]+$/);
  const state = JSON.parse(await readFile(path.join(scratch, "state.json"), "utf8"));
  assert.equal(state.root, scratch);
  assert.ok(!(await lstat(scratch)).isSymbolicLink());
  const nox = (root, args, allowFailure = false) => {
    const result = execute(process.execPath, [state.cli, ...args, "--root", root, "--json"], root, {
      allowFailure,
    });
    return { exit: result.code, value: JSON.parse(result.stdout) };
  };
  const director = (args) =>
    execute(state.director, args, state.app, {
      env: { ...environment, DIRECTOR_HUB: path.join(scratch, "hub") },
    }).stdout;
  if (mode === "recover") {
    await recover(state, nox, director);
  } else if (mode === "setup") {
    assert.ok(!state.app, "Do not replay setup over an existing experiment");
    state.app = path.join(scratch, "application");
    state.cli = path.join(scratch, "runtime/dist/cli.js");
    state.owned.push("runtime", "application", "hub");
    await save(path.join(scratch, "state.json"), state);
    await cp(path.resolve("dist"), path.join(scratch, "runtime/dist"), { recursive: true });
    await cp(path.resolve("package.json"), path.join(scratch, "runtime/package.json"));
    for (const name of ["yaml", "zod", "commander"])
      await cp(
        path.resolve("node_modules", name),
        path.join(scratch, "runtime/node_modules", name),
        { recursive: true },
      );
    await mkdir(path.join(state.app, "src"), { recursive: true });
    await mkdir(path.join(state.app, "tests"));
    await mkdir(path.join(state.app, "docs"));
    await writeFile(
      path.join(state.app, "package.json"),
      JSON.stringify({
        name: "gateway-worker-acceptance",
        private: true,
        type: "module",
        packageManager: "npm@11.0.0",
        scripts: { test: "node --test" },
      }),
    );
    await writeFile(
      path.join(state.app, "src/retry.js"),
      "export function retryDelay(attempt) { return Math.min(5000, 100 * 2 ** attempt); }\n",
    );
    await writeFile(
      path.join(state.app, "tests/retry.test.mjs"),
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {retryDelay} from '../src/retry.js'; test('retry backoff',()=>{assert.equal(retryDelay(0),100);assert.equal(retryDelay(3),800);assert.equal(retryDelay(9),5000);});\n",
    );
    state.originalInstructions =
      "# Gateway worker\n\nRead [workflow guidance](docs/workflow.md). Director is a coordination ledger for decisions, open-items, handoffs and notes; it does not run coding workers. Keep its state separate from project knowledge.\n";
    await writeFile(path.join(state.app, "AGENTS.md"), state.originalInstructions);
    await writeFile(path.join(state.app, "CLAUDE.md"), "@AGENTS.md\n");
    await writeFile(
      path.join(state.app, "docs/workflow.md"),
      "# Workflow\n\nDirector keeps work state; Noxroot supplies task context and approved checks. Do not import Director's log into documentation.\n",
    );
    git(state.app, ["init"]);
    git(state.app, ["config", "user.name", "Acceptance test"]);
    git(state.app, ["config", "user.email", "acceptance@example.invalid"]);
    git(state.app, ["add", "."]);
    git(state.app, ["commit", "-m", "fixture application"]);
    state.directorAdopt = director(["adopt"]);
    state.directorDecision = director([
      "emit",
      "--type",
      "decision",
      "--area",
      "retry",
      "Gateway retry diagnostics use milliseconds; preserve exact delays when correlating queue metrics.",
    ]);
    state.directorBefore = director(["render"]);
    const preview = nox(state.app, ["preview"]).value;
    assert.ok(preview.initializationAllowed);
    assert.ok(
      preview.proposedFiles.every(
        (p) => p.action === "reference" || p.path === "AGENTS.md" || p.path.startsWith(".noxroot/"),
      ),
    );
    state.capabilities = preview.capabilities;
    nox(state.app, ["init", "--yes"]);
    const agentFile = await readFile(path.join(state.app, "AGENTS.md"), "utf8");
    assert.ok(agentFile.startsWith(state.originalInstructions.trimEnd()));
    assert.equal(await readFile(path.join(state.app, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
    // Use the candidate build, not the published pin, only in this explicitly prepared fixture.
    await writeFile(
      path.join(state.app, "AGENTS.md"),
      agentFile.replaceAll("npx --yes noxroot@0.1.0", `node ${state.cli}`),
    );
    await writeFile(
      path.join(state.app, ".noxroot/verification.yml"),
      `version: 1\ncommands:\n  - id: retry-tests\n    executable: ${process.execPath}\n    args: ['--test']\n    cwd: .\n    timeoutMs: 10000\n    appliesTo: ['src/**', 'tests/**']\n`,
    );
    git(state.app, ["add", "."]);
    git(state.app, ["commit", "-m", "reviewed local Director and Noxroot setup"]);
    state.setupBaseline = git(state.app, ["rev-parse", "HEAD"]);
    const task = nox(state.app, ["start", "reject negative retry attempts"]).value;
    state.firstTask = task.record.id;
    await writeFile(
      path.join(state.app, "src/retry.js"),
      "export function retryDelay(attempt) { if (!Number.isInteger(attempt) || attempt < 0) throw new RangeError('attempt must be a non-negative integer'); return Math.min(5000, 100 * 2 ** attempt); }\n",
    );
    await writeFile(
      path.join(state.app, "tests/retry.test.mjs"),
      (await readFile(path.join(state.app, "tests/retry.test.mjs"), "utf8")) +
        "test('reject invalid attempt',()=>{assert.throws(()=>retryDelay(-1),RangeError);assert.throws(()=>retryDelay(0.5),RangeError);});\n",
    );
    const finished = nox(state.app, ["finish"]).value;
    assert.equal(finished.record.status, "completed");
    state.firstChecks = finished.record.verification;
    state.firstDiff = git(state.app, ["diff"]);
    // Scripted review input validates plumbing, not an independent model's discovery of the lesson.
    await save(path.join(state.app, ".noxroot/local/fixture-review.json"), {
      schemaVersion: 2,
      taskId: state.firstTask,
      changeId: finished.record.changeIdentity.changeId,
      decision: "approved",
      summary:
        "Scripted acceptance review: exact millisecond delays and invalid-attempt regression passed.",
      findings: [],
      learningCandidates: [
        {
          kind: "decision",
          destination: ".noxroot/knowledge/retry-diagnostics.md",
          evidence: [
            "retry-tests verifies 100, 800 and 5000 millisecond delays",
            "Existing Director decision specifies queue-metric correlation",
          ],
          expectedValue: "Keep retry diagnostic messages in the same units as queue metrics.",
          content:
            "Retry diagnostic messages use milliseconds, not rounded seconds. Preserve the exact retryDelay value when describing retry scheduling so operators can correlate queue metrics.",
          whyNotExecutable:
            "The numerical behavior is tested; this records the operational reason for diagnostic units.",
        },
      ],
    });
    nox(state.app, [
      "finish",
      "--task",
      state.firstTask,
      "--review-file",
      ".noxroot/local/fixture-review.json",
    ]);
    git(state.app, ["add", "src", "tests"]);
    git(state.app, ["commit", "-m", "fixture invalid retry attempts"]);
    state.control = path.join(scratch, "control");
    state.owned.push("control");
    await cp(state.app, state.control, { recursive: true });
    // Copy before accepting learning; no active task state is resumed by later sessions.
    const taskText =
      "Add a retrySummary(attempt) helper that describes retry scheduling for operators. Preserve retryDelay behavior and add regression tests.";
    state.taskText = taskText;
    state.beforeLearning = nox(state.app, ["context", taskText]).value;
    state.proposals = nox(state.app, ["learn", "--task", state.firstTask]).value;
    assert.equal(state.proposals.proposals.length, 1);
    state.applied = nox(state.app, ["learn", "--task", state.firstTask, "--apply", "--yes"]).value;
    git(state.app, ["add", ".noxroot/knowledge"]);
    git(state.app, ["commit", "-m", "fixture accepted retry diagnostic rationale"]);
    state.related = nox(state.app, ["context", taskText]).value;
    state.unrelated = nox(state.app, ["context", "adjust invoice currency formatting"]).value;
    await save(path.join(scratch, "state.json"), state);
    const lesson = ".noxroot/knowledge/retry-diagnostics.md";
    assert.ok(!state.beforeLearning.selected.some((x) => x.path === lesson));
    assert.ok(state.related.selected.some((x) => x.path === lesson));
    assert.ok(!state.unrelated.selected.some((x) => x.path === lesson));
    assert.equal(nox(state.app, ["learn", "--task", state.firstTask]).value.proposals.length, 0);
    assert.equal(director(["render"]), state.directorBefore);
    state.stage = "prepared";
    await save(path.join(scratch, "state.json"), state);
    console.log(
      JSON.stringify(
        {
          root: scratch,
          firstTask: state.firstTask,
          firstStatus: finished.record.status,
          capabilities: state.capabilities,
          learning: { before: false, related: true, unrelated: false, duplicate: false },
          directorPreserved: true,
        },
        null,
        2,
      ),
    );
  } else if (mode === "agents") {
    assert.equal(state.stage, "prepared");
    assert.equal(state.sessions.length, 0);
    for (const [label, root] of [
      ["without-accepted-lesson", state.control],
      ["with-accepted-lesson", state.app],
    ]) {
      const before = git(root, ["rev-parse", "HEAD"]);
      assert.equal(git(root, ["status", "--porcelain", "--untracked-files=all"]), "");
      const result = await freshAgent(root, state.taskText);
      const runs = await records({ root });
      const latest = runs.find((r) => r.baseline?.revision === before);
      const diff = git(root, ["diff", "--no-ext-diff", "--binary"]);
      state.sessions.push({ label, ...result, record: latest, diff });
      await save(path.join(scratch, "state.json"), state);
      assert.equal(result.exit, 0);
      assert.equal(latest?.status, "completed");
      checkpoint(root, before, diff, label);
      console.log(`${label}: completed`);
    }
    assert.equal(director(["render"]), state.directorBefore);
    state.directorHandoff = director([
      "emit",
      "--type",
      "handoff",
      "--area",
      "retry",
      "Retry summary checked. Next: operator review; no deployment.",
    ]);
    state.directorAfter = director(["render"]);
    state.stage = "completed";
    await save(path.join(scratch, "state.json"), state);
  } else throw new Error(`Unknown mode ${mode}; prepared state retained at ${state.root}`);
}
