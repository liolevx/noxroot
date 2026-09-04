import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const fixtures = path.resolve(import.meta.dirname, "fixtures");

export async function temporaryDirectory(prefix = "noxroot-test-"): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

export async function fixtureCopy(
  name: string,
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await temporaryDirectory();
  await cp(path.join(fixtures, name), root, { recursive: true });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      hash.update(
        `${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f"}:${relative}\0`,
      );
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) hash.update(await readFile(absolute));
    }
  }
  await visit(root);
  return hash.digest("hex");
}

export async function makeEmptyGit(root: string): Promise<void> {
  await mkdir(path.join(root, ".git"), { recursive: true });
  await mkdir(path.join(root, ".git", "refs", "heads"), { recursive: true });
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
