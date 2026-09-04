import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setupDestination } from "../security/paths.js";

export class TaskStateError extends Error {}

async function pathType(candidate: string): Promise<"file" | "directory" | undefined> {
  try {
    const value = await stat(candidate);
    return value.isFile() ? "file" : value.isDirectory() ? "directory" : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function legacyStateRoot(root: string): Promise<string> {
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

export async function localStateRoot(root: string): Promise<string> {
  const legacy = await legacyStateRoot(root);
  if (!(await pathType(path.join(root, ".git")))) return legacy;
  const local = await setupDestination(root, ".noxroot/local");
  if (await pathType(legacy)) {
    if (await pathType(local)) {
      throw new TaskStateError(
        "Two task-state directories exist. Stop and reconcile the existing records before retrying; neither directory was changed.",
      );
    }
    return legacy;
  }
  return local;
}

function stateError(error: unknown, directory: string): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (["EACCES", "EPERM", "EROFS"].includes(code ?? "")) {
    throw new TaskStateError(
      `Task state is not writable: ${directory}\nNext: request write access to this directory and retry. Do not edit after a failed start or report completion after a failed finish. Existing records have not been moved.`,
    );
  }
  throw error;
}

export async function prepareStateRoot(root: string): Promise<string> {
  const directory = await localStateRoot(root);
  try {
    await mkdir(directory, { recursive: true });
    if (directory === path.resolve(root, ".noxroot", "local")) {
      const ignore = await setupDestination(root, ".noxroot/local/.gitignore");
      try {
        await writeFile(ignore, "*\n", { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await readFile(ignore, "utf8")) !== "*\n") {
          throw new TaskStateError(
            "Local task-state ignore policy differs from the managed '*' rule. Restore that rule before recording tasks; the existing file was not changed.",
          );
        }
      }
    }
    return directory;
  } catch (error) {
    stateError(error, directory);
  }
}

export async function assertTaskStateWritable(root: string): Promise<void> {
  const directory = await prepareStateRoot(root);
  const probe = await setupDestination(directory, `runs/.write-check-${randomUUID()}`);
  try {
    await mkdir(path.dirname(probe), { recursive: true });
    await writeFile(probe, "", { flag: "wx", mode: 0o600 });
    await unlink(probe);
  } catch (error) {
    stateError(error, directory);
  }
}

export async function writeRunRecord(root: string, id: string, value: unknown): Promise<string> {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("Task id contains unsupported characters.");
  const stateRoot = await prepareStateRoot(root);
  const directory = path.join(stateRoot, "runs");
  const target = await setupDestination(stateRoot, `runs/${id}.json`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return target;
  } catch (error) {
    stateError(error, directory);
  }
}

export async function readRunRecord<T>(root: string, id: string): Promise<T> {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("Task id contains unsupported characters.");
  const directory = await localRunDirectory(root);
  return JSON.parse(await readFile(await setupDestination(directory, `${id}.json`), "utf8")) as T;
}

export async function replaceRunRecord(root: string, id: string, value: unknown): Promise<string> {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("Task id contains unsupported characters.");
  const stateRoot = await localStateRoot(root);
  const target = await setupDestination(stateRoot, `runs/${id}.json`);
  await stat(target);
  const temporary = `${target}.tmp-${randomUUID()}`;
  let created = false;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    created = true;
    await rename(temporary, target);
    return target;
  } catch (error) {
    return stateError(error, stateRoot);
  } finally {
    if (created)
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}

export async function localRunDirectory(root: string): Promise<string> {
  const stateRoot = await localStateRoot(root);
  return (await pathType(stateRoot))
    ? setupDestination(stateRoot, "runs")
    : path.join(stateRoot, "runs");
}

export async function listRunRecords<T>(root: string): Promise<T[]> {
  const directory = await localRunDirectory(root);
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
      records.push(
        JSON.parse(await readFile(await setupDestination(directory, name), "utf8")) as T,
      );
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
  const directory = await localRunDirectory(root);
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
        await readFile(await setupDestination(directory, name), "utf8"),
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
