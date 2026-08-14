import { renderToString } from "ink";
import { createElement } from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, it, vi } from "vitest";
import type { UserSkillListItem } from "../../../shared/host/inputBindings";
import { ComposerSuggestionOverlay } from "./ComposerSuggestionOverlay";

const skill: UserSkillListItem = {
  qualifiedName: "project:review",
  name: "review",
  scope: "project",
  description: "Review the current changes",
};

const command = {
  matches: [{ name: "/status", description: "Show status" }],
  open: true,
  select: vi.fn(),
  dismiss: vi.fn(),
};
const file = {
  query: "src",
  open: true,
  select: vi.fn(),
  dismiss: vi.fn(),
};
const skillSuggestion = {
  matches: [skill],
  open: true,
  select: vi.fn(),
  dismiss: vi.fn(),
  createTokenId: vi.fn(() => "skill-1"),
};
const keySink = { current: null };

function render(overrides: {
  commandOpen?: boolean;
  skillOpen?: boolean;
  fileOpen?: boolean;
}): string {
  return stripAnsi(
    renderToString(
      createElement(ComposerSuggestionOverlay, {
        command: { ...command, open: overrides.commandOpen ?? true },
        skill: { ...skillSuggestion, open: overrides.skillOpen ?? true },
        file: { ...file, open: overrides.fileOpen ?? true },
        availableSkills: [skill],
        visibleRows: 5,
        keySink,
      }),
      { columns: 100 },
    ),
  );
}

describe("ComposerSuggestionOverlay", () => {
  it("gives command suggestions priority", () => {
    const output = render({});

    expect(output).toContain("/status");
    expect(output).not.toContain("$review");
  });

  it("gives skill suggestions priority over file suggestions", () => {
    const output = render({ commandOpen: false });

    expect(output).toContain("$review");
    expect(output).not.toContain("No matching paths");
  });

  it("renders nothing when no suggestion is active", () => {
    expect(render({ commandOpen: false, skillOpen: false, fileOpen: false })).toBe("");
  });
});
