// Run the complete suite from a clean committed tree in a disposable Linux directory.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
if (process.platform === "win32") throw Error("Run in WSL/Linux.");
const source = path.resolve(import.meta.dirname, "../..");
const scratch = await mkdtemp("/tmp/noxroot-linux-check-");
const workspace = path.join(scratch, "workspace");
try {
  await mkdir(workspace);
  const archive = spawnSync("git", ["archive", "HEAD"], { cwd: source, maxBuffer: 16_000_000 });
  if (archive.status !== 0) throw Error("Cannot archive the committed tree");
  const unpack = spawnSync("tar", ["-x", "-C", workspace], { input: archive.stdout });
  if (unpack.status !== 0) throw Error("Cannot unpack the committed tree");
  for (const args of [
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", path.join(scratch, "cache")],
    ["run", "check"],
  ]) {
    const result = spawnSync("npm", args, { cwd: workspace, stdio: "inherit", timeout: 300_000 });
    if (result.status !== 0) throw Error(`npm ${args.join(" ")} failed (${result.status})`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
  console.log("Removed the isolated Linux validation tree and package cache.");
}
