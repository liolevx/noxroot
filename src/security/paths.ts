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
