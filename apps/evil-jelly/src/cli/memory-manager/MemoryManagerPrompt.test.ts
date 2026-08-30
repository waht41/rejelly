import { renderToString } from "ink";
import { createElement } from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, it, vi } from "vitest";
import { buildMemoryDetailLines, MemoryManagerPrompt } from "./MemoryManagerPrompt";

const detail = {
  id: "mem-project-review",
  scope: "project" as const,
  title: "PR description guidance",
  summary:
    "Check the remote branch before opening a PR and preserve the complete structured body without omitting its ending.",
  detail:
    "Treat the PR description as the squash-merge commit message. Keep every heading and list item intact, including this final instruction.",
  revision: 4,
  createdAt: "2026/08/22 12:58:25",
  updatedAt: "2026/08/22 20:38:19",
  provenance: '{\n  "created": {\n    "source": "agent"\n  }\n}',
  injectedStatus: "current" as const,
};

describe("MemoryManagerPrompt", () => {
  it("wraps long detail fields into scrollable visual lines without omitting text", () => {
    const lines = buildMemoryDetailLines(detail, 48);
    const normalizedLines = lines.join("\n").replace(/\s+/g, " ");

    expect(lines.length).toBeGreaterThan(11);
    expect(normalizedLines).toContain(detail.summary);
    expect(normalizedLines).toContain(detail.detail);
    expect(lines.some((line) => line.endsWith("…"))).toBe(false);
  });

  it("renders the wrapped memory detail viewport and scroll affordance", () => {
    const output = stripAnsi(
      renderToString(
        createElement(MemoryManagerPrompt, {
          request: { entries: [detail], canRevealFile: true, detail },
          onAction: vi.fn(),
        }),
        { columns: 48 },
      ),
    );

    expect(output).toContain("Memory · PR description guidance");
    expect(output).toContain("Summary: Check the remote branch before");
    expect(output).toContain("Lines 1–12 of");
    expect(output).toContain("O reveal · D delete · Esc back");
  });
});
