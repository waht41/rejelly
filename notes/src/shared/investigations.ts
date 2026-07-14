export type InvestigationStatus = "active" | "later" | "resolved" | "superseded" | "archived";

export interface InvestigationMetadata {
  title: string;
  status: InvestigationStatus;
  createdAt: string;
  updatedAt: string;
  type: "investigation";
  scope?: string;
  [key: string]: unknown;
}

export interface InvestigationSummary {
  id: string;
  slug: string;
  fileName: string;
  relativePath: string;
  metadata: InvestigationMetadata;
  synopsis: string;
}

export interface InvestigationDetail extends InvestigationSummary {
  body: string;
  frontmatter: string;
}
