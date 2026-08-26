import { renderToString } from "ink";
import { createElement } from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, it, vi } from "vitest";
import { buildSkillDetailLines, SkillManagerPrompt } from "./SkillManagerPrompt";

const entry = {
  qualifiedName: "project:review",
  name: "review",
  scope: "project" as const,
  description: "Review a change",
  shortDescription: "Review changes",
  resourceCount: 1,
};

describe("SkillManagerPrompt", () => {
  it("renders a navigable Skill list", () => {
    const output = stripAnsi(
      renderToString(
        createElement(SkillManagerPrompt, {
          request: { entries: [entry], canOpenFolder: true },
          onAction: vi.fn(),
        }),
        { columns: 100 },
      ),
    );

    expect(output).toContain("Local Skills");
    expect(output).toContain("▸ [project] review — Review changes · 1 resources");
    expect(output).toContain("Enter details");
  });

  it("renders clearly separated detail sections while keeping instructions raw", () => {
    const detail = {
      ...entry,
      description:
        "Review a change carefully across the complete workspace. The ending remains visible after wrapping.",
      rootPath: "E:\\skills\\review",
      mainPath: "E:\\skills\\review\\SKILL.md",
      pathConvention: "windows" as const,
      instructionCharacters: 120,
      instruction: "# Inspect every changed file.\n\n- Report concrete findings.",
      resources: [{ path: "references/guide.md", kind: "reference" as const, sizeBytes: 42 }],
    };
    const output = stripAnsi(
      renderToString(
        createElement(SkillManagerPrompt, {
          request: {
            entries: [entry],
            canOpenFolder: true,
            detail,
          },
          onAction: vi.fn(),
        }),
        { columns: 80 },
      ),
    );
    const normalizedOutput = output.replace(/\s+/g, " ");

    expect(output).toContain("Skill · review");
    expect(output).toContain("Identity");
    expect(output).toContain("Name: review");
    expect(output).toContain("Description");
    expect(normalizedOutput).toContain(
      "Review a change carefully across the complete workspace. The ending remains visible after wrapping.",
    );
    expect(output).toContain("Instructions · 120 characters");
    expect(output).toContain("# Inspect every changed file.");
    expect(output).toContain("O open folder · Esc back");

    const visualLines = buildSkillDetailLines(detail, 80);
    expect(visualLines.filter((line) => line.tone === "section").map((line) => line.text)).toEqual([
      "Identity",
      "Description",
      "Instructions · 120 characters",
      "Filesystem",
      "Resources · 1",
      "Access policy",
    ]);
    const fullDetail = visualLines.map((line) => line.text).join("\n");
    expect(fullDetail).toContain("# Inspect every changed file.\n\n- Report concrete findings.");
    expect(fullDetail).toContain("Root: E:\\skills\\review");
    expect(fullDetail).toContain("Main: E:\\skills\\review\\SKILL.md");
    expect(fullDetail).toContain("references/guide.md (reference, 42 bytes)");
  });
});
