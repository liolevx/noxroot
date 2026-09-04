import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./process.js";
import { prepareStateRoot } from "../state/local.js";
import { isSuspectedSecret, resolveWithin } from "../security/paths.js";

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
  branch: string;
}

export interface ChangeIdentity {
  schemaVersion: 1;
  baselineRevision: string;
  changedPaths: string[];
  changeId: string;
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
  const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (
    topLevel.exitCode !== 0 ||
    revision.exitCode !== 0 ||
    branch.exitCode !== 0 ||
    status.exitCode !== 0
  ) {
    throw new Error("Guided completion requires a Git repository with at least one commit.");
  }
  const repositoryRoot = await realpath(path.resolve(topLevel.stdout.trim()));
  const requestedRoot = await realpath(path.resolve(root));
  if (requestedRoot.toLowerCase() !== repositoryRoot.toLowerCase()) {
    throw new Error(`Guided tasks must start at the Git repository root: ${repositoryRoot}`);
  }
  return {
    root: repositoryRoot,
    revision: revision.stdout.trim(),
    status: status.stdout,
    branch: branch.stdout.trim(),
  };
}

export async function revisionInCurrentHistory(root: string, revision: string): Promise<boolean> {
  if (!/^[a-f0-9]{40}$/i.test(revision)) return false;
  const result = await git(root, ["merge-base", "--is-ancestor", revision, "HEAD"]);
  return result.exitCode === 0;
}

export async function identifyChange(
  root: string,
  baselineRevision: string,
  changedPaths: string[],
): Promise<ChangeIdentity> {
  const normalizedPaths = [
    ...new Set(changedPaths.map((value) => value.replaceAll("\\", "/"))),
  ].sort();
  const hash = createHash("sha256");
  hash.update("noxroot-change-identity-v1\0");
  hash.update(baselineRevision);
  const trackedMetadata = await git(
    root,
    ["diff", "--raw", "--no-abbrev", "-z", baselineRevision, "--"],
    1_000_000,
  );
  if (trackedMetadata.exitCode !== 0 || trackedMetadata.outputTruncated) {
    throw new Error("Complete Git change metadata could not be captured safely.");
  }
  hash.update("\0git-raw\0");
  hash.update(trackedMetadata.stdout);

  for (const relative of normalizedPaths) {
    const absolute = resolveWithin(root, relative);
    hash.update("\0path\0");
    hash.update(relative);
    let entry;
    try {
      entry = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        hash.update("\0deleted");
        continue;
      }
      throw error;
    }

    if (entry.isSymbolicLink()) {
      hash.update("\0symlink\0");
      hash.update(await readlink(absolute));
    } else if (entry.isFile()) {
      hash.update(`\0file\0size:${entry.size}\0`);
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(absolute);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("error", reject);
        stream.on("end", resolve);
      });
    } else if (entry.isDirectory()) {
      hash.update("\0directory");
    } else {
      hash.update("\0other");
    }
  }

  return {
    schemaVersion: 1,
    baselineRevision,
    changedPaths: normalizedPaths,
    changeId: hash.digest("hex"),
  };
}

function matchesSensitivePath(relative: string, patterns: string[]): boolean {
  const normalized = relative.replaceAll("\\", "/");
  return patterns.some((value) => {
    const pattern = value.replaceAll("\\", "/").replace(/^\.\//, "");
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("**", "\0")
      .replaceAll("*", "[^/]*")
      .replaceAll("\0", ".*")
      .replaceAll("?", "[^/]");
    return new RegExp(`^(?:${escaped})(?:/.*)?$`).test(normalized);
  });
}

export async function diffFromRevision(
  root: string,
  revision: string,
  sensitivePaths: string[] = [],
  excludedPaths: string[] = [],
): Promise<string> {
  const tracked = await git(root, ["diff", "--name-only", "-z", revision, "--"], 100_000);
  if (tracked.exitCode !== 0) return `Diff unavailable: ${tracked.stderr.trim()}`;
  const protectedTracked: Array<{ path: string; symlink: boolean }> = [];
  for (const relative of tracked.stdout.split("\0").filter(Boolean)) {
    let symlink = false;
    try {
      symlink = (await lstat(resolveWithin(root, relative))).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (symlink || isSuspectedSecret(relative) || matchesSensitivePath(relative, sensitivePaths)) {
      protectedTracked.push({ path: relative, symlink });
    }
  }
  const result = await git(
    root,
    [
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--unified=20",
      revision,
      "--",
      ".",
      ...protectedTracked.map((entry) => `:(top,exclude,literal)${entry.path}`),
      ...excludedPaths.map((entry) => `:(top,exclude,literal)${entry}`),
    ],
    100_000,
  );
  if (result.exitCode !== 0) return `Diff unavailable: ${result.stderr.trim()}`;
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], 100_000);
  if (untracked.exitCode !== 0) return result.stdout;
  let remaining = Math.max(0, 100_000 - Buffer.byteLength(result.stdout));
  const additions: string[] = [];
  for (const entry of protectedTracked) {
    if (remaining <= 0) break;
    const redacted = `\ndiff --git a/${entry.path} b/${entry.path}\n--- a/${entry.path}\n+++ b/${entry.path}\n${entry.symlink ? `Symlink target and content omitted for ${entry.path}.` : `Content omitted for sensitive path ${entry.path}.`}\n`;
    const bounded = Buffer.from(redacted).subarray(0, remaining).toString("utf8");
    additions.push(bounded);
    remaining -= Buffer.byteLength(bounded);
  }
  for (const relative of untracked.stdout.split("\0").filter(Boolean).sort()) {
    if (excludedPaths.includes(relative)) continue;
    if (remaining <= 0) break;
    const absolute = resolveWithin(root, relative);
    const file = await lstat(absolute);
    const header = `\ndiff --git a/${relative} b/${relative}\nnew file mode ${file.isSymbolicLink() ? "120000" : "100644"}\n--- /dev/null\n+++ b/${relative}\n`;
    let body: string;
    if (isSuspectedSecret(relative) || matchesSensitivePath(relative, sensitivePaths)) {
      body = `Content omitted for sensitive path ${relative}.\n`;
    } else if (file.isSymbolicLink()) {
      body = `Symlink target and content omitted for ${relative}.\n`;
    } else {
      const source = await readFile(absolute);
      body = source.includes(0)
        ? `Binary file ${relative} (${source.byteLength} bytes)\n`
        : source.toString("utf8");
    }
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
  const stateRoot = await prepareStateRoot(root);
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

export async function boundedDiff(
  worktree: IsolatedWorktree,
  sensitivePaths: string[] = [],
): Promise<string> {
  return diffFromRevision(worktree.path, worktree.baseRevision, sensitivePaths);
}
