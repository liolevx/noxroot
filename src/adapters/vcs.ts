import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./process.js";
import { localStateRoot } from "../state/local.js";

export interface IsolatedWorktree {
  branch: string;
  path: string;
  baseRevision: string;
  dirtySourceWorktree: boolean;
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
