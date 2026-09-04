// Read bounded operational evidence; never read Codex authentication or raw rollout files.
import path from "node:path";
import { readFile } from "node:fs/promises";
const scratch = process.argv[2];
if (!/^\/tmp\/noxroot-workflows-[\w-]+$/.test(scratch ?? ""))
  throw new Error("Supply a prepared acceptance workspace.");
const state = JSON.parse(await readFile(path.join(scratch, "state.json"), "utf8"));
for (const [index, original] of state.repositories.entries()) {
  let row = original;
  for (const name of [`python-${index}.json`, `js-${index}.json`, `monorepo-${index}.json`]) {
    try {
      row = JSON.parse(await readFile(path.join(scratch, name), "utf8"));
    } catch {
      /* Not started yet. */
    }
  }
  if (process.argv[3] && index !== Number(process.argv[3])) continue;
  console.log(
    JSON.stringify(
      {
        repo: row.repo,
        result: row.result,
        error: row.error,
        sessions: row.sessions.map((session) => ({
          exit: session.exitCode,
          records: session.records?.map((record) => record.status),
          changed: session.changed,
          knowledgeChanged: session.knowledgeChanged,
          summary: session.summary,
        })),
        ...(row.result?.includes("blocked")
          ? {
              baseline: {
                code: row.nativeBaseline?.code,
                stdout: row.nativeBaseline?.stdout?.slice(-3000),
                stderr: row.nativeBaseline?.stderr?.slice(-1500),
              },
              install: {
                code: row.install?.code,
                stdout: row.install?.stdout?.slice(-3000),
                stderr: row.install?.stderr?.slice(-1500),
              },
            }
          : {}),
      },
      null,
      2,
    ),
  );
}
