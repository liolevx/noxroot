// Compare the same approved check outside the agent sandbox; never change its policy or timeout.
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { nox, records, save } from "./workflow-support.mjs";
const scratch = process.argv[2];
if (!/^\/tmp\/noxroot-workflows-[\w-]+$/.test(scratch ?? ""))
  throw new Error("Supply a prepared acceptance workspace.");
const state = JSON.parse(await readFile(path.join(scratch, "state.json"), "utf8"));
const file = path.join(scratch, "python-6.json");
const row = JSON.parse(await readFile(file, "utf8"));
assert.equal(row.repo, "encode/starlette");
const summarize = (all) =>
  all.map((record) => ({
    id: record.id,
    status: record.status,
    verification: record.verification,
    verificationGaps: record.verificationGaps,
  }));
row.operatorDiagnostic = {
  before: summarize(await records(row)),
  method:
    "Same published CLI finish and unchanged 30-second policy, executed by the operator outside the Codex command sandbox. Does not convert the failed autonomous session into a pass.",
};
const result = nox(state, row, ["finish"]);
row.operatorDiagnostic.exit = result.code;
row.operatorDiagnostic.after = summarize(await records(row));
await save(file, row);
console.log(JSON.stringify(row.operatorDiagnostic, null, 2));
