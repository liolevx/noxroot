import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PreviewResult, ProposedFile } from "../model.js";
import { resolveWithin } from "../security/paths.js";

export interface ApplyResult {
  created: string[];
  patched: string[];
  referenced: string[];
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function writableProposal(
  proposal: ProposedFile,
): proposal is ProposedFile & { action: "create" | "patch"; content: string } {
  return (
    (proposal.action === "create" || proposal.action === "patch") && proposal.content !== undefined
  );
}

export async function applyProposals(preview: PreviewResult): Promise<ApplyResult> {
  if (!preview.initializationAllowed) {
    throw new Error(
      "Initialization stopped because initialization is refused by the reviewed preview.",
    );
  }
  const writable = preview.proposedFiles.filter(writableProposal);
  const references = preview.proposedFiles
    .filter((proposal) => proposal.action === "reference")
    .map((proposal) => proposal.path);
  for (const proposal of writable) {
    const target = resolveWithin(preview.root, proposal.path);
    if (proposal.action === "create" && (await exists(target))) {
      throw new Error(
        `Initialization stopped because ${proposal.path} now exists; run preview again.`,
      );
    }
    if (proposal.action === "patch") {
      if (!(await exists(target))) {
        throw new Error(
          `Initialization stopped because ${proposal.path} no longer exists; run preview again.`,
        );
      }
      const current = await readFile(target, "utf8");
      const currentHash = createHash("sha256").update(current).digest("hex");
      if (!proposal.expectedHash || currentHash !== proposal.expectedHash) {
        throw new Error(
          `Initialization stopped because ${proposal.path} changed after preview; run preview again.`,
        );
      }
    }
  }

  const created: string[] = [];
  const patched: string[] = [];
  const originals = new Map<string, string>();
  const createdDirectories: string[] = [];
  const temporary: string[] = [];
  try {
    for (const proposal of writable) {
      const target = resolveWithin(preview.root, proposal.path);
      const createdDirectory = await mkdir(path.dirname(target), { recursive: true });
      if (createdDirectory) {
        let directory = path.dirname(target);
        while (directory.length >= createdDirectory.length) {
          createdDirectories.push(directory);
          if (directory === createdDirectory) break;
          directory = path.dirname(directory);
        }
      }
      if (proposal.action === "patch") originals.set(target, await readFile(target, "utf8"));
      const temp = path.join(path.dirname(target), `.noxroot-${randomUUID()}.tmp`);
      temporary.push(temp);
      await writeFile(temp, proposal.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temp, target);
      temporary.splice(temporary.indexOf(temp), 1);
      if (proposal.action === "create") created.push(proposal.path);
      else patched.push(proposal.path);
    }
    return { created, patched, referenced: references };
  } catch (error) {
    await Promise.allSettled(temporary.map((file) => rm(file, { force: true })));
    await Promise.allSettled(
      created.map((relative) => rm(resolveWithin(preview.root, relative), { force: true })),
    );
    await Promise.allSettled(
      [...originals.entries()].map(([target, content]) => writeFile(target, content, "utf8")),
    );
    for (const directory of [...new Set(createdDirectories)].sort(
      (left, right) => right.length - left.length,
    )) {
      await rmdir(directory).catch(() => undefined);
    }
    throw error;
  }
}
