import path from "node:path";
import { ConfigurationError, loadConfig } from "../config/load.js";
import type { PreviewResult } from "../model.js";
import { scanRepository } from "../detection/scan.js";
import { canonicalDirectory } from "../security/paths.js";
import { assessModules, buildProposals } from "./proposals.js";

export async function previewRepository(root = process.cwd()): Promise<PreviewResult> {
  const canonicalRoot = await canonicalDirectory(root);
  let configuredModules: Set<string> | undefined;
  let sensitivePaths: string[] = [];
  let configurationConflict: string | undefined;
  try {
    const config = await loadConfig(canonicalRoot);
    if (config) {
      configuredModules = new Set(config.modules);
      sensitivePaths = config.sensitivePaths;
    }
  } catch (error) {
    if (error instanceof ConfigurationError) configurationConflict = error.message;
    else throw error;
  }
  const profile = await scanRepository(canonicalRoot, { sensitivePaths });
  const modules = assessModules(profile, configuredModules);
  const proposedFiles = await buildProposals(profile, modules);
  const existingSetup = profile.evidence
    .filter((item) => item.status === "confirmed")
    .map((item) => `${item.claim}: ${item.sources.join(", ")}`);
  const conflicts = profile.evidence
    .filter((item) => item.status === "conflicting")
    .map((item) => `${item.claim}: ${item.sources.join(", ")}`);
  if (configurationConflict) conflicts.push(configurationConflict);
  if (profile.blockedSymlinks.length > 0) {
    conflicts.push(
      `${profile.blockedSymlinks.length} symbolic link(s) were not followed: ${profile.blockedSymlinks.join(", ")}`,
    );
  }
  const unknowns = profile.empty
    ? [
        "Product intent",
        "Deliverable type",
        "Language or framework",
        "Verification commands",
        "Deployment and user journeys",
      ]
    : [
        ...(profile.evidence.some((item) => item.claim.includes("Continuous integration"))
          ? []
          : ["Continuous integration"]),
        ...(profile.candidateCommands.length > 0 ? [] : ["Approved verification commands"]),
      ];
  const defaultPaths = ["AGENTS.md", ".noxroot/config.yml", ".noxroot/knowledge/INDEX.md"];
  const proposedContent = new Map(
    proposedFiles
      .filter((file) => file.content !== undefined)
      .map((file) => [file.path, Buffer.byteLength(file.content!)]),
  );
  const defaultBytes = defaultPaths.reduce(
    (total, file) => total + (proposedContent.get(file) ?? profile.fileSizes[file] ?? 0),
    0,
  );
  return {
    kind: "preview",
    root: path.normalize(canonicalRoot),
    profile,
    modules,
    proposedFiles,
    existingSetup,
    conflicts,
    unknowns,
    contextEstimate: {
      defaultBytes,
      estimatedTokens: Math.ceil(defaultBytes / 4),
    },
    trust: {
      repositoryFilesChanged: 0,
      repositoryCommandsExecuted: 0,
      agentCallsMade: 0,
      networkRequestsMade: 0,
    },
  };
}
