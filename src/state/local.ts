import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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
