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
  maxFiles: number;
  scope: VerifyScope;
  tests: boolean;
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
  changedFileCount?: number;
  scope: ResolvedVerifyScope;
  steps: VerifyStep[];
  unmappedFiles?: string[];
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

export interface BranchReport {
  ahead: number;
  base: string;
  behind: number;
  branch: string;
  commits: BranchCommit[];
  diff: BranchDiffStat;
  head: string;
  mergeBase: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  upstream?: string;
}
