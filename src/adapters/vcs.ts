import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./process.js";
import { localStateRoot } from "../state/local.js";

export interface IsolatedWorktree {
  branch: string;
  path: string;
  baseRevision: string;
  dirtySourceWorktree: boolean;
}

export interface RepositoryBaseline {
  root: string;
  revision: string;
  status: string;
}

function taskSlug(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug || "task";
}

async function git(root: string, args: string[], outputLimitBytes = 65_536) {
  return runProcess({
    executable: "git",
    args,
    cwd: root,
    repositoryRoot: root,
    timeoutMs: 30_000,
    outputLimitBytes,
  });
}

export async function captureRepositoryBaseline(root: string): Promise<RepositoryBaseline> {
  const topLevel = await git(root, ["rev-parse", "--show-toplevel"]);
  const revision = await git(root, ["rev-parse", "HEAD"]);
  const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (topLevel.exitCode !== 0 || revision.exitCode !== 0 || status.exitCode !== 0) {
    throw new Error("Guided completion requires a Git repository with at least one commit.");
  }
  const repositoryRoot = path.resolve(topLevel.stdout.trim());
  if (path.resolve(root).toLowerCase() !== repositoryRoot.toLowerCase()) {
    throw new Error(`Guided tasks must start at the Git repository root: ${repositoryRoot}`);
  }
  return { root: repositoryRoot, revision: revision.stdout.trim(), status: status.stdout };
}

export async function diffFromRevision(root: string, revision: string): Promise<string> {
  const result = await git(
    root,
    ["diff", "--no-ext-diff", "--no-color", "--unified=20", revision, "--"],
    100_000,
  );
  if (result.exitCode !== 0) return `Diff unavailable: ${result.stderr.trim()}`;
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], 100_000);
  if (untracked.exitCode !== 0) return result.stdout;
  let remaining = Math.max(0, 100_000 - Buffer.byteLength(result.stdout));
  const additions: string[] = [];
  for (const relative of untracked.stdout.split("\0").filter(Boolean).sort()) {
    if (remaining <= 0) break;
    const source = await readFile(path.resolve(root, relative));
    const header = `\ndiff --git a/${relative} b/${relative}\nnew file mode 100644\n--- /dev/null\n+++ b/${relative}\n`;
    const body = source.includes(0)
      ? `Binary file ${relative} (${source.byteLength} bytes)\n`
      : source.toString("utf8");
    const entry = `${header}${body}`;
    const bounded = Buffer.from(entry).subarray(0, remaining).toString("utf8");
    additions.push(bounded);
    remaining -= Buffer.byteLength(bounded);
  }
  return `${result.stdout}${additions.join("")}`;
}

export async function prepareIsolatedWorktree(
  root: string,
  task: string,
  id: string,
): Promise<IsolatedWorktree> {
  const revision = await git(root, ["rev-parse", "HEAD"]);
  if (revision.exitCode !== 0) {
    throw new Error(
      "Delegated runs require a Git repository with at least one commit; use --guided first.",
    );
  }
  const status = await git(root, ["status", "--porcelain=v1"]);
  if (status.exitCode !== 0) throw new Error("Git status could not be inspected safely.");
  const stateRoot = await localStateRoot(root);
  const worktreesRoot = path.join(stateRoot, "worktrees");
  await mkdir(worktreesRoot, { recursive: true });
  const worktreePath = path.join(worktreesRoot, id);
  const branch = `noxroot/${taskSlug(task)}-${id.slice(-6)}`;
  const created = await git(root, ["worktree", "add", "-b", branch, worktreePath, "HEAD"], 100_000);
  if (created.exitCode !== 0) {
    throw new Error(`Git could not create the isolated worktree: ${created.stderr.trim()}`);
  }
  return {
    branch,
    path: worktreePath,
    baseRevision: revision.stdout.trim(),
    dirtySourceWorktree: status.stdout.trim().length > 0,
  };
}

export async function boundedDiff(worktree: IsolatedWorktree): Promise<string> {
  const result = await git(
    worktree.path,
    ["diff", "--no-ext-diff", "--no-color", "--unified=20", worktree.baseRevision, "--"],
    100_000,
  );
  if (result.exitCode !== 0) return `Diff unavailable: ${result.stderr.trim()}`;
  return result.stdout;
}
