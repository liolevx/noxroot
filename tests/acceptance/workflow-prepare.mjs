// Prepare inspectable, pinned disposable copies. Does not execute target scripts or agents.
import path from "node:path";
import { readFile } from "node:fs/promises";
import { checkout, save, workspace } from "./workflow-support.mjs";

const selected = [
  "expressjs/morgan",
  "expressjs/express",
  "chalk/chalk",
  "markdown-it/markdown-it",
  "psf/requests",
  "encode/httpx",
  "encode/starlette",
  "pallets/flask",
  "nuxt/nuxt",
  "withastro/astro",
];
const breadth = JSON.parse(
  await readFile(new URL("./adoption-results-2026-09-04.json", import.meta.url), "utf8"),
);
const state = await workspace();
console.log(`Workspace: ${state.root}`);
try {
  for (const [index, repo] of selected.entries()) {
    const spec = breadth.results.find((item) => item.repo === repo);
    const row = await checkout(state, { repo, revision: spec.revision }, index);
    state.repositories.push(row);
    await save(path.join(state.root, "state.json"), state);
    console.log(`${index + 1}/${selected.length} prepared ${repo}`);
  }
} finally {
  await save(path.join(state.root, "state.json"), state);
}
