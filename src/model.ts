export type EvidenceStatus = "confirmed" | "declared" | "inferred" | "unknown" | "conflicting";

export type ModuleStatus =
  "recommended" | "optional" | "enabled" | "disabled" | "not applicable" | "blocked";

export interface Evidence {
  status: EvidenceStatus;
  claim: string;
  sources: string[];
  detail?: string;
}

export interface ModuleAssessment {
  id:
    | "repository-profile"
    | "agent-routing"
    | "project-knowledge"
    | "verification"
    | "product-ux"
    | "orchestration"
    | "learning"
    | "browser-qa";
  label: string;
  status: ModuleStatus;
  reason: string;
}

export interface InspectionLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxContentBytes: number;
  maxDepth: number;
  maxDurationMs: number;
}

export interface InspectionStats {
  filesVisited: number;
  contentBytesRead: number;
  durationMs: number;
  incompleteReasons: string[];
}

export interface CandidateCommand {
  id: string;
  executable: string;
  args: string[];
  cwd: string;
  source: string;
  appliesTo: string[];
}

export interface RepositoryProfile {
  root: string;
  empty: boolean;
  git: boolean;
  files: string[];
  fileSizes: Record<string, number>;
  evidence: Evidence[];
  suspectedSecrets: string[];
  blockedSymlinks: string[];
  candidateCommands: CandidateCommand[];
  documents: RepositoryDocument[];
  packageManager: PackageManagerEvidence;
  stats: InspectionStats;
}

export interface PackageManagerEvidence {
  name?: "npm" | "pnpm" | "yarn" | "bun";
  status: "confirmed" | "inferred" | "unknown" | "conflicting";
  sources: string[];
  detail: string;
}

export interface RepositoryDocument {
  path: string;
  kind:
    | "instructions"
    | "architecture"
    | "product"
    | "ux"
    | "testing"
    | "security"
    | "contribution"
    | "ordinary";
  authoritative: boolean;
}

export interface ProposedFile {
  path: string;
  action: "create" | "reference" | "patch";
  reason: string;
  content?: string;
  patch?: string;
  expectedHash?: string;
}

export type CapabilityDecision = "create" | "reuse" | "conflict" | "not-assessed";

export interface CapabilityAssessment {
  id:
    | "project-knowledge"
    | "task-routes"
    | "verification-policy"
    | "verification-skill"
    | "task-orchestration"
    | "product-ux-guidance";
  label: string;
  decision: CapabilityDecision;
  evidence: string[];
  missingEvidence: string[];
}

export interface PreviewResult {
  kind: "preview";
  root: string;
  profile: RepositoryProfile;
  modules: ModuleAssessment[];
  proposedFiles: ProposedFile[];
  capabilities: CapabilityAssessment[];
  initializationAllowed: boolean;
  existingSetup: string[];
  conflicts: string[];
  unknowns: string[];
  contextEstimate: {
    defaultBytes: number;
    estimatedTokens: number;
  };
  trust: {
    repositoryFilesChanged: 0;
    repositoryCommandsExecuted: 0;
    agentCallsMade: 0;
    networkRequestsMade: 0;
  };
}

export interface ContextSelection {
  path: string;
  bytes: number;
  estimatedTokens: number;
  reasons: string[];
}

export interface TaskIntent {
  requiredOutcomes: string[];
  explicitExclusions: string[];
  requestedAuthority: string[];
  acceptanceCriteria: string[];
}

export interface ContextPackage {
  task: string;
  interpretation: string;
  intent: TaskIntent;
  confidence: "high" | "partial" | "insufficient";
  repositoryFileCount: number;
  eligibleCandidateFiles: number;
  applicableAreas: string[];
  selected: ContextSelection[];
  likelyOwningSource: string[];
  likelyTests: string[];
  constraints: string[];
  requiredVerification: CandidateCommand[];
  conflicts: string[];
  unknowns: string[];
  excluded: Array<{ path: string; reason: string }>;
  budget: { maximumBytes: number; selectedBytes: number; estimatedTokens: number };
}

export interface VerificationCommand {
  id: string;
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  appliesTo: string[];
}

export interface ProcessEvidence {
  executable: string;
  args: string[];
  cwd: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface VerificationResult {
  command: VerificationCommand;
  evidence: ProcessEvidence;
  status: "passed" | "failed" | "timed-out" | "unavailable";
}
