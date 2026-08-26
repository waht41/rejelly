import { renderToString } from "ink";
import { createElement } from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, it, vi } from "vitest";
import { SkillManagerPrompt } from "./SkillManagerPrompt";

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

  it("renders access paths, resources, and the open-folder action in detail", () => {
    const output = stripAnsi(
      renderToString(
        createElement(SkillManagerPrompt, {
          request: {
            entries: [entry],
            canOpenFolder: true,
            detail: {
              ...entry,
              description:
                "Review a change carefully across the complete workspace. The ending remains visible after wrapping.",
              rootPath: "E:\\skills\\review",
              mainPath: "E:\\skills\\review\\SKILL.md",
              pathConvention: "windows",
              instructionCharacters: 120,
              instruction: "Inspect every changed file.\nReport concrete findings.",
              resources: [{ path: "references/guide.md", kind: "reference", sizeBytes: 42 }],
            },
          },
          onAction: vi.fn(),
        }),
        { columns: 80 },
      ),
    );
    const normalizedOutput = output.replace(/\s+/g, " ");

    expect(output).toContain("Skill · review");
    expect(normalizedOutput).toContain(
      "Description: Review a change carefully across the complete workspace. The ending remains visible after wrapping.",
    );
    expect(output).toContain("Instructions (120 characters):");
    expect(output).toContain("Inspect every changed file.");
    expect(output).toContain("Root: E:\\skills\\review");
    expect(output).toContain("Main: E:\\skills\\review\\SKILL.md");
    expect(output).toContain("references/guide.md (reference, 42 bytes)");
    expect(output).toContain("O open folder · Esc back");
  });
});
