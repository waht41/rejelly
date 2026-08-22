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
const referenceSuggestion = {
  matches: [{ kind: "skill" as const, skill }],
  open: true,
  select: vi.fn(),
  dismiss: vi.fn(),
};
const keySink = { current: null };

function render(overrides: {
  commandOpen?: boolean;
  referenceOpen?: boolean;
  fileOpen?: boolean;
}): string {
  return stripAnsi(
    renderToString(
      createElement(ComposerSuggestionOverlay, {
        command: { ...command, open: overrides.commandOpen ?? true },
        reference: { ...referenceSuggestion, open: overrides.referenceOpen ?? true },
        file: { ...file, open: overrides.fileOpen ?? true },
        availableSkills: [skill],
        availableMcpServers: [],
        availableMemories: [],
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

  it("gives semantic reference suggestions priority over file suggestions", () => {
    const output = render({ commandOpen: false });

    expect(output).toContain("$review");
    expect(output).not.toContain("No matching paths");
  });

  it("renders nothing when no suggestion is active", () => {
    expect(render({ commandOpen: false, referenceOpen: false, fileOpen: false })).toBe("");
  });
});
