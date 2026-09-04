// Opt-in read-only context probes on two retained legacy checkouts. No upstream writes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

if (process.platform === "win32") throw Error("Run in WSL/Linux.");
const retained = path.resolve(process.argv[2] ?? "");
assert.match(retained, /^\/tmp\/noxroot-legacy-acceptance-[^/]+$/);
const source = path.resolve(import.meta.dirname, "../..");
const scratch = await mkdtemp("/tmp/noxroot-large-context-");
function run(executable, args, cwd = source) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8_000_000,
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
async function hashTree(root) {
  const hash = createHash("sha256");
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = path.join(directory, entry.name);
      hash.update(path.relative(root, file));
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) hash.update(await readFile(file));
    }
  }
  await walk(root);
  return hash.digest("hex");
}
try {
  const packed = JSON.parse(run("npm", ["pack", "--pack-destination", scratch, "--json"]))[0];
  const install = path.join(scratch, "install");
  await mkdir(install);
  run("npm", [
    "install",
    "--prefix",
    install,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--cache",
    path.join(scratch, "cache"),
    path.join(scratch, packed.filename),
  ]);
  const cli = path.join(install, "node_modules/noxroot/dist/cli.js");
  const invoke = (root, ...args) =>
    JSON.parse(run("node", [cli, ...args, "--root", root, "--json"]));
  const report = { packageBytes: packed.size, probes: [] };
  for (const [name, owner, task, symbol] of [
    ["underscore", "underscore.js", "test groupBy preserves input order within groups", "groupBy"],
    ["bottle", "bottle.py", "test integer router parameters with leading zeros", "'int':"],
  ]) {
    const original = path.join(retained, name);
    const status = run("git", ["status", "--porcelain"], original);
    const originalHash = await hashTree(original);
    const existing = invoke(original, "context", task);
    assert.equal(await hashTree(original), originalHash);
    assert.equal(existing.confidence, "insufficient");
    assert(existing.unknowns.some((item) => item.includes("Active routes exclude source files")));
    const root = path.join(scratch, name);
    await mkdir(root);
    // Archive committed upstream source into a disposable, non-Git source copy.
    const archive = spawnSync("git", ["archive", "HEAD"], { cwd: original, maxBuffer: 16_000_000 });
    assert.equal(archive.status, 0);
    assert.equal(spawnSync("tar", ["-x", "-C", root], { input: archive.stdout }).status, 0);
    const preview = invoke(root, "preview");
    assert.equal(preview.initializationAllowed, true);
    assert(
      preview.proposedFiles.every(
        (file) =>
          file.path === "AGENTS.md" ||
          file.path.startsWith(".noxroot/") ||
          file.action === "reference",
      ),
    );
    invoke(root, "init", "--yes");
    // Reuse the exact operator-approved check from the previous acceptance, not auto-discovery.
    await writeFile(
      path.join(root, ".noxroot/verification.yml"),
      await readFile(path.join(original, ".noxroot/verification.yml")),
    );
    const before = await hashTree(root);
    const context = invoke(root, "context", task);
    assert.deepEqual(context, invoke(root, "context", task));
    assert.equal(await hashTree(root), before);
    assert.equal(run("git", ["status", "--porcelain"], original), status);
    const selected = context.selected.find((item) => item.path === owner);
    assert(selected?.lineRanges?.length, `${name}: missing implementation ranges`);
    assert.equal(context.likelyOwningSource[0], owner);
    assert.equal(context.confidence, "partial");
    const lines = (await readFile(path.join(root, owner), "utf8")).match(/[^\n]*\n|[^\n]+$/g);
    const excerpt = selected.lineRanges
      .map(({ start, end }) => lines.slice(start - 1, end).join(""))
      .join("");
    assert(excerpt.includes(symbol), `${name}: selected windows miss ${symbol}`);
    assert.equal(Buffer.byteLength(excerpt), selected.bytes);
    assert(context.budget.selectedBytes <= 16_000);
    report.probes.push({
      name,
      revision: run("git", ["rev-parse", "HEAD"], original),
      oldRoutes: "preserved; explicit recovery guidance",
      confidence: context.confidence,
      selected: context.selected,
      owners: context.likelyOwningSource,
      tests: context.likelyTests,
      budget: context.budget,
      unknowns: context.unknowns,
      readOnly: true,
    });
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
  console.log("Removed disposable source copies, CLI install, package, and cache.");
}
