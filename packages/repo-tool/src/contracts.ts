export type BiomeScope = "all" | "changed" | "skip";

export type VerifyScope =
  | { kind: "affected" }
  | { filters: string[]; kind: "filtered" }
  | { kind: "all" };

export type ResolvedVerifyScope =
  | { kind: "all" }
  | { filters: string[]; kind: "packages"; source: "affected" | "explicit" }
  | { kind: "none"; source: "affected" };

export interface VerifyOptions {
  allowMany: boolean;
  base?: string;
  biome: BiomeScope;
  dryRun: boolean;
  fix: boolean;
  fixBranch: boolean;
  json: boolean;
  maxFiles: number;
  scope: VerifyScope;
  tests: boolean;
  timeoutMs?: number;
  verbose: boolean;
}

export interface ProcessVerifyStep {
  args: string[];
  command: string;
  kind: "process";
  label: string;
}

export interface BiomeChangedVerifyStep {
  kind: "biome-changed";
  label: string;
  selection?: BiomeChangedSelection;
  write: boolean;
}

export interface BiomeChangedSelection {
  base: string;
  files: string[];
}

export type VerifyStep = BiomeChangedVerifyStep | ProcessVerifyStep;

export interface VerifyPlan {
  changeSummary?: VerifyChangeSummary;
  changedFileCount?: number;
  scope: ResolvedVerifyScope;
  steps: VerifyStep[];
  unmappedFiles?: string[];
}

export interface VerifyChangeSummary {
  biomeFiles: number;
  directPackages: string[];
  excludedFiles: number;
  globalFiles: string[];
  neutralRootFiles: string[];
  totalFiles: number;
  workingTreeFiles: number;
}

export interface VerifyExecutionStepResult {
  cancelled: boolean;
  durationMs: number;
  exitCode: number;
  label: string;
  timedOut: boolean;
}

export interface VerifyFailureReport {
  diagnostics: string;
  diagnosticsTruncated: boolean;
  failedTasks: string[];
  failedTestFiles: string[];
  step: string;
}

export interface VerifyExecutionReport {
  changeSummary?: VerifyChangeSummary;
  exitCode: number;
  failure?: VerifyFailureReport;
  plan: VerifyPlan;
  schemaVersion: 1;
  scope: ResolvedVerifyScope;
  status: "cancelled" | "failed" | "passed" | "timed_out";
  steps: VerifyExecutionStepResult[];
}

export interface VerifyRunResult {
  exitCode: number;
  report: VerifyExecutionReport;
}

export interface BranchCommit {
  shortSha: string;
  subject: string;
}

export interface BranchDiffStat {
  binary: number;
  deletions: number;
  files: number;
  insertions: number;
}

export type BranchStatusCode = "A" | "C" | "D" | "M" | "R" | "T" | "U" | "X";

export interface BranchWorkingTreeChange {
  indexStatus?: BranchStatusCode;
  originalPath?: string;
  path: string;
  untracked?: true;
  worktreeStatus?: BranchStatusCode;
}

export interface BranchReport {
  ahead: number;
  base: string;
  behind: number;
  branch: string;
  commits: BranchCommit[];
  commitsTruncated: boolean;
  diff: BranchDiffStat;
  head: string;
  mergeBase: string;
  schemaVersion: 2;
  upstream?: string;
  workingTree: BranchWorkingTreeChange[];
}
