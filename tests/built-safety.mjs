import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function hashTree(root) {
  const hash = createHash("sha256");
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      hash.update(`${entry.isDirectory() ? "d" : "f"}:${path.relative(root, absolute)}\0`);
      if (entry.isDirectory()) await visit(absolute);
      else hash.update(await readFile(absolute));
    }
  }
  await visit(root);
  return hash.digest("hex");
}

const root = await mkdtemp(path.join(tmpdir(), "noxroot-built-safety-"));
try {
  const marker = path.join(root, "executed.txt");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "permission-fixture",
      scripts: {
        test: `node -e \"require('fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')\"`,
      },
    }),
  );
  const before = await hashTree(root);
  const cli = path.resolve("dist", "cli.js");
  const result = spawnSync(
    process.execPath,
    ["--permission", "--allow-fs-read=*", cli, "preview", "--root", root, "--no-color"],
    { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
  );
  if (result.status !== 0) {
    throw new Error(`Permission-confined preview failed:\n${result.stderr}\n${result.stdout}`);
  }
  if (!result.stdout.includes("network requests 0")) {
    throw new Error("Compiled preview did not report its network guarantee.");
  }
  if (await readFile(marker, "utf8").catch(() => undefined)) {
    throw new Error("Preview executed a project command.");
  }
  if ((await hashTree(root)) !== before) {
    throw new Error("Permission-confined preview changed repository-visible state.");
  }
  process.stdout.write(
    "Compiled preview passed with child-process, network, and write permissions denied.\n",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
