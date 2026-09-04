// Resume the preserved, clean fixture after discovering the default-route defect.
import assert from "node:assert/strict";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { git, records, save } from "./workflow-support.mjs";

export async function recover(state, nox, director) {
  assert.ok(!state.stage && state.sessions.length === 0);
  state.control = path.join(state.root, "control");
  state.owned = [...new Set([...state.owned, "control"])];
  state.taskText =
    "Add a retrySummary(attempt) helper that describes retry scheduling for operators. Preserve retryDelay behavior and add regression tests.";
  for (const root of [state.app, state.control])
    assert.equal(git(root, ["status", "--porcelain"]), "");
  state.firstRecord = (await records({ root: state.app })).find(
    (r) => r.task === "reject negative retry attempts",
  );
  assert.ok(state.firstRecord, "Recover only the known completed fixture");
  assert.equal(state.firstRecord.status, "approved");
  state.firstTask = state.firstRecord.id;
  state.firstChecks = state.firstRecord.verification;
  state.directorBefore = director(["render"]);
  assert.ok(state.directorBefore.includes("Gateway retry diagnostics use milliseconds"));
  state.recovery = {
    reason:
      "Setup assertion exposed the index-only default route. Preserve the failed evidence; explicitly review and commit the route migration in both copies.",
    before: nox(state.app, ["context", state.taskText]).value,
    commits: [],
  };
  assert.ok(
    state.recovery.before.excluded.some(
      (x) => x.path === ".noxroot/knowledge/retry-diagnostics.md",
    ),
  );
  await save(path.join(state.root, "state.json"), state);
  await cp(path.resolve("dist"), path.join(state.root, "runtime/dist"), { recursive: true });
  for (const root of [state.app, state.control]) {
    const route = path.join(root, ".noxroot/routes.yml");
    const before = await readFile(route, "utf8");
    assert.ok(before.includes("- .noxroot/knowledge/INDEX.md"));
    await writeFile(
      route,
      before.replace("- .noxroot/knowledge/INDEX.md", "- .noxroot/knowledge/**"),
    );
    git(root, ["add", ".noxroot/routes.yml"]);
    git(root, ["commit", "-m", "fixture reviewed knowledge route migration"]);
    state.recovery.commits.push({ root, commit: git(root, ["rev-parse", "HEAD"]) });
  }
  state.beforeLearning = nox(state.control, ["context", state.taskText]).value;
  state.related = nox(state.app, ["context", state.taskText]).value;
  state.unrelated = nox(state.app, ["context", "adjust invoice currency formatting"]).value;
  const lesson = ".noxroot/knowledge/retry-diagnostics.md";
  assert.ok(!state.beforeLearning.selected.some((x) => x.path === lesson));
  assert.ok(state.related.selected.some((x) => x.path === lesson));
  assert.ok(!state.unrelated.selected.some((x) => x.path === lesson));
  state.acceptedLesson = await readFile(path.join(state.app, lesson), "utf8");
  state.duplicateProposals = nox(state.app, [
    "learn",
    "--task",
    state.firstTask,
  ]).value.proposals.length;
  assert.equal(state.duplicateProposals, 0);
  assert.equal(await readFile(path.join(state.app, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.equal(director(["render"]), state.directorBefore);
  state.stage = "prepared";
  await save(path.join(state.root, "state.json"), state);
  console.log(
    "Preserved fixture resumed: related lesson selected; unrelated and control excluded; duplicate proposals zero.",
  );
}
