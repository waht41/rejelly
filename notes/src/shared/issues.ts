export type IssueSeverity = "critical" | "high" | "medium" | "low";

export type IssueStatus = "open" | "in-progress" | "later" | "done" | "wontfix";

export interface IssueEvidence {
  file?: string;
  line?: number;
  note?: string;
}

export interface IssueRelation {
  issue?: string;
  kind?: string;
}

export interface IssueMetadata {
  title: string;
  severity: IssueSeverity;
  status: IssueStatus;
  createdAt: string;
  updatedAt: string;
  type?: string;
  priority?: string;
  areas?: string[];
  legacyIds?: string[];
  disposition?: string[];
  silent?: boolean;
  blocksHappyPath?: boolean;
  closedAt?: string;
  resolution?: string;
  aliases?: string[];
  evidence?: IssueEvidence[];
  relations?: IssueRelation[];
  [key: string]: unknown;
}

export interface IssueSummary {
  id: string;
  slug: string;
  fileName: string;
  relativePath: string;
  metadata: IssueMetadata;
  description: string;
}

export interface IssueDetail extends IssueSummary {
  body: string;
  frontmatter: string;
}
