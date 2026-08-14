import { renderToString } from "ink";
import { createElement } from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, it, vi } from "vitest";
import type { UserSkillListItem } from "../../../../shared/host/inputBindings";
import { SkillPickerOverlay } from "./SkillPickerOverlay";

const items: UserSkillListItem[] = [
  {
    qualifiedName: "user:short",
    name: "short",
    scope: "user",
    description: "Short description",
  },
  {
    qualifiedName: "project:much-longer-name",
    name: "much-longer-name",
    scope: "project",
    description: "Longer description",
  },
];

describe("SkillPickerOverlay", () => {
  it("renders aligned title, type, and description columns", () => {
    const output = stripAnsi(
      renderToString(
        createElement(SkillPickerOverlay, {
          items,
          getReferenceName: (skill) => skill.name,
          onSelect: vi.fn(),
          onCancel: vi.fn(),
        }),
        { columns: 120 },
      ),
    );
    const lines = output.split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("▸ $short");
    expect(lines[1]).toContain("  $much-longer-name");
    expect(lines[0]).toContain("[Skill] Short description");
    expect(lines[1]).toContain("[Skill] Longer description");
    expect(lines[0]!.indexOf("[Skill]")).toBe(lines[1]!.indexOf("[Skill]"));
  });

  it("keeps each item on one row and truncates descriptions to the remaining width", () => {
    const output = stripAnsi(
      renderToString(
        createElement(SkillPickerOverlay, {
          items,
          getReferenceName: (skill) => skill.name,
          onSelect: vi.fn(),
          onCancel: vi.fn(),
        }),
        { columns: 48 },
      ),
    );
    const lines = output.split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^▸ \$short\s+\[Skill\]/);
    expect(lines[1]).toMatch(/^ {2}\$much-longer-name\s+\[Skill\]/);
  });

  it("shows qualified names only when multiple Skills share a name", () => {
    const duplicateItems: UserSkillListItem[] = [
      {
        qualifiedName: "user:review",
        name: "review",
        scope: "user",
        description: "Personal review",
      },
      {
        qualifiedName: "project:review",
        name: "review",
        scope: "project",
        description: "Project review",
      },
    ];
    const output = stripAnsi(
      renderToString(
        createElement(SkillPickerOverlay, {
          items: duplicateItems,
          getReferenceName: (skill) => skill.qualifiedName,
          onSelect: vi.fn(),
          onCancel: vi.fn(),
        }),
        { columns: 80 },
      ),
    );

    expect(output).toContain("▸ $user:review");
    expect(output).toContain("  $project:review");
  });
});
