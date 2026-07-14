import { describe, expect, it } from "vitest";
import {
  type DocPairCandidate,
  docSyncIdentityFor,
  missingCounterpartVerdict,
  renderDocSyncSectionTable,
} from "./docSync";

function pair(over: Partial<DocPairCandidate> = {}): DocPairCandidate {
  return {
    name: "docs/zh/api/core.md ⇄ docs/en/api/core.md",
    leftFile: "docs/zh/api/core.md",
    rightFile: "docs/en/api/core.md",
    leftText: "# 核心\n\n正文",
    rightText: "# Core\n\nBody",
    ...over,
  };
}

describe("docSyncIdentityFor", () => {
  it("keeps the fingerprint stable across content edits but changes the content hash", () => {
    const before = docSyncIdentityFor(pair());
    const after = docSyncIdentityFor(pair({ rightText: "# Core\n\nEdited body" }));

    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.id).toBe(before.id);
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it("distinguishes a missing side from an empty file", () => {
    const missing = docSyncIdentityFor(pair({ rightText: null }));
    const empty = docSyncIdentityFor(pair({ rightText: "" }));
    expect(missing.contentHash).not.toBe(empty.contentHash);
  });

  it("keys the fingerprint by both files", () => {
    const a = docSyncIdentityFor(pair());
    const b = docSyncIdentityFor(pair({ leftFile: "docs/zh/api/other.md" }));
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("keeps shared-left multilingual pairs distinct", () => {
    const a = docSyncIdentityFor(pair({ rightFile: "docs/en/api/core.md" }));
    const b = docSyncIdentityFor(pair({ rightFile: "docs/ja/api/core.md" }));
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe("missingCounterpartVerdict", () => {
  it("is deterministic, actionable, and names the file to create", () => {
    const verdict = missingCounterpartVerdict(pair({ rightText: null }));

    expect(verdict.isActionable).toBe(true);
    expect(verdict.severity).toBe("high");
    expect(verdict.category).toBe("missing-file");
    expect(verdict.summary).toContain("docs/en/api/core.md");
    expect(verdict.proposal).toContain("docs/en/api/core.md");
    expect(verdict.proposal).toContain("docs/zh/api/core.md");
  });

  it("reports the left side when left is the missing one", () => {
    const verdict = missingCounterpartVerdict(pair({ leftText: null }));
    expect(verdict.summary).toContain("docs/zh/api/core.md");
    expect(verdict.proposal).toContain("docs/zh/api/core.md");
  });
});

describe("renderDocSyncSectionTable", () => {
  it("renders one row per section and escapes pipes/newlines in cells", () => {
    const table = renderDocSyncSectionTable([
      { heading: "Overview", grade: "ok", note: "" },
      { heading: "Options | Flags", grade: "inconsistent", note: "en lacks\nthe new flag" },
      { heading: "迁移指南", grade: "left-only", note: "no right section" },
    ]);

    expect(table).toContain("| Section | Grade | Note |");
    expect(table).toContain("| Overview | ok |  |");
    expect(table).toContain("| Options \\| Flags | inconsistent | en lacks the new flag |");
    expect(table).toContain("| 迁移指南 | left-only | no right section |");
  });

  it("returns an empty string for an empty section list", () => {
    expect(renderDocSyncSectionTable([])).toBe("");
  });
});
