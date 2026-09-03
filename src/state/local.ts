import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

async function pathType(candidate: string): Promise<"file" | "directory" | undefined> {
  try {
    const value = await stat(candidate);
    return value.isFile() ? "file" : value.isDirectory() ? "directory" : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function localStateRoot(root: string): Promise<string> {
  const gitMarker = path.join(root, ".git");
  const type = await pathType(gitMarker);
  if (type === "directory") return path.join(gitMarker, "noxroot");
  if (type === "file") {
    const pointer = (await readFile(gitMarker, "utf8")).trim();
    if (!pointer.startsWith("gitdir: ")) throw new Error("Invalid .git worktree pointer.");
    const gitDirectory = path.resolve(root, pointer.slice("gitdir: ".length));
    const commonPointer = path.join(gitDirectory, "commondir");
    try {
      const common = (await readFile(commonPointer, "utf8")).trim();
      return path.join(path.resolve(gitDirectory, common), "noxroot");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return path.join(gitDirectory, "noxroot");
    }
  }
  const digest = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 20);
  const appData =
    process.platform === "win32"
      ? (process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"))
      : (process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"));
  return path.join(appData, "noxroot", "repositories", digest);
}

export async function writeRunRecord(root: string, id: string, value: unknown): Promise<string> {
  const stateRoot = await localStateRoot(root);
  const directory = path.join(stateRoot, "runs");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${id}.json`);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return target;
}

export async function readRunRecord<T>(root: string, id: string): Promise<T> {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("Task id contains unsupported characters.");
  const stateRoot = await localStateRoot(root);
  return JSON.parse(await readFile(path.join(stateRoot, "runs", `${id}.json`), "utf8")) as T;
}

export async function replaceRunRecord(root: string, id: string, value: unknown): Promise<string> {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("Task id contains unsupported characters.");
  const stateRoot = await localStateRoot(root);
  const target = path.join(stateRoot, "runs", `${id}.json`);
  await stat(target);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, target);
  return target;
}

export async function listRunRecords<T>(root: string): Promise<T[]> {
  const directory = path.join(await localStateRoot(root), "runs");
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: T[] = [];
  for (const name of names) {
    try {
      records.push(JSON.parse(await readFile(path.join(directory, name), "utf8")) as T);
    } catch {
      // A malformed or concurrently replaced record is not eligible for implicit selection.
    }
  }
  return records;
}

export interface RunRetentionResult {
  removed: string[];
  retained: number;
  protected: number;
}

interface RetentionRecord {
  id?: unknown;
  status?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
}

const TERMINAL_RUN_STATUSES = new Set(["approved", "completed"]);

function recordTime(record: RetentionRecord): number {
  const value =
    typeof record.finishedAt === "string"
      ? record.finishedAt
      : typeof record.startedAt === "string"
        ? record.startedAt
        : undefined;
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export async function enforceRunRetention(
  root: string,
  policy: { evidenceDays: number; maximumRuns: number },
  now = Date.now(),
  preserveIds: readonly string[] = [],
): Promise<RunRetentionResult> {
  const directory = path.join(await localStateRoot(root), "runs");
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => /^[a-z0-9-]+\.json$/i.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { removed: [], retained: 0, protected: 0 };
    }
    throw error;
  }

  const removable: Array<{ name: string; timestamp: number }> = [];
  const preservedNames = new Set(preserveIds.map((id) => `${id}.json`));
  let protectedCount = 0;
  for (const name of names) {
    try {
      const record = JSON.parse(
        await readFile(path.join(directory, name), "utf8"),
      ) as RetentionRecord;
      if (preservedNames.has(name)) {
        protectedCount += 1;
      } else if (typeof record.status === "string" && TERMINAL_RUN_STATUSES.has(record.status)) {
        removable.push({ name, timestamp: recordTime(record) });
      } else {
        protectedCount += 1;
      }
    } catch {
      protectedCount += 1;
    }
  }

  removable.sort(
    (left, right) => right.timestamp - left.timestamp || left.name.localeCompare(right.name),
  );
  const cutoff = now - policy.evidenceDays * 24 * 60 * 60 * 1000;
  const capacity = Math.max(0, policy.maximumRuns - protectedCount);
  const keep = new Set(
    removable
      .filter((item) => item.timestamp >= cutoff)
      .slice(0, capacity)
      .map((item) => item.name),
  );
  const removed = removable.filter((item) => !keep.has(item.name)).map((item) => item.name);
  for (const name of removed) await unlink(path.join(directory, name));

  return {
    removed: removed.map((name) => name.replace(/\.json$/i, "")),
    retained: names.length - removed.length,
    protected: protectedCount,
  };
}
