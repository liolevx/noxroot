import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PreviewResult } from "../model.js";
import { resolveWithin } from "../security/paths.js";

export interface ApplyResult {
  created: string[];
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

export async function applyProposals(preview: PreviewResult): Promise<ApplyResult> {
  const creatable = preview.proposedFiles.filter(
    (proposal): proposal is typeof proposal & { content: string } =>
      proposal.action === "create" && proposal.content !== undefined,
  );
  for (const proposal of creatable) {
    const target = resolveWithin(preview.root, proposal.path);
    if (await exists(target)) {
      throw new Error(
        `Initialization stopped because ${proposal.path} now exists; run preview again.`,
      );
    }
  }

  const created: string[] = [];
  const createdDirectories: string[] = [];
  const temporary: string[] = [];
  try {
    for (const proposal of creatable) {
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
      const temp = path.join(path.dirname(target), `.noxroot-${randomUUID()}.tmp`);
      temporary.push(temp);
      await writeFile(temp, proposal.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temp, target);
      temporary.splice(temporary.indexOf(temp), 1);
      created.push(proposal.path);
    }
    return { created };
  } catch (error) {
    await Promise.allSettled(temporary.map((file) => rm(file, { force: true })));
    await Promise.allSettled(
      created.map((relative) => rm(resolveWithin(preview.root, relative), { force: true })),
    );
    for (const directory of [...new Set(createdDirectories)].sort(
      (left, right) => right.length - left.length,
    )) {
      await rmdir(directory).catch(() => undefined);
    }
    throw error;
  }
}
