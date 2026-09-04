import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

const SECRET_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "credentials.json",
  "secrets.yml",
  "secrets.yaml",
  "id_rsa",
  "id_ed25519",
]);

export function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

export function isSuspectedSecret(relativePath: string): boolean {
  const base = path.posix.basename(normalizeRelative(relativePath)).toLowerCase();
  return (
    SECRET_BASENAMES.has(base) ||
    /^\.env\./.test(base) ||
    /\.(?:pem|p12|pfx|key)$/.test(base) ||
    /^(?:secret|credentials?)(?:\.|$)/.test(base)
  );
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveWithin(root: string, relativePath: string): string {
  const candidate = path.resolve(root, relativePath);
  if (!isWithin(root, candidate)) {
    throw new Error(`Path escapes the selected repository: ${relativePath}`);
  }
  return candidate;
}

export async function canonicalDirectory(candidate: string): Promise<string> {
  const resolved = await realpath(candidate);
  const stat = await lstat(resolved);
  if (!stat.isDirectory()) throw new Error(`Repository root is not a directory: ${candidate}`);
  return resolved;
}

// Setup accepts canonical roots from preview. Refuse links, including in-repository
// links, so the reviewed destination never silently redirects a write.
export async function setupDestination(root: string, relativePath: string): Promise<string> {
  const target = resolveWithin(root, relativePath);
  if ((await lstat(root)).isSymbolicLink()) {
    throw new Error("Setup stopped: repository root is a symbolic link; run preview again.");
  }
  if (path.relative(root, await realpath(root)) !== "") {
    throw new Error("Setup stopped: repository root changed; run preview again.");
  }
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Setup stopped: ${normalizeRelative(path.relative(root, current))} is a symbolic link; use an unlinked destination and run preview again.`,
      );
    }
    if (current !== target && !entry.isDirectory()) {
      throw new Error(`Setup stopped: ${path.relative(root, current)} is not a directory.`);
    }
  }
  return target;
}
