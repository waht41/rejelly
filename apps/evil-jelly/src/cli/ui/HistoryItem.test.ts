import { renderToString } from "ink";
import { createElement } from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import type { Turn } from "../store/useOutputStore";
import { HistoryItem } from "./HistoryItem";

const COLUMNS = 60;

function renderTurn(turn: Turn): string[] {
  const output = renderToString(createElement(HistoryItem, { turn }), { columns: COLUMNS });
  return stripAnsi(output).split("\n");
}

const toolTurn = (summary: string, preview = "", fullResult = ""): Turn => ({
  id: "t_1",
  type: "tool",
  content: summary,
  tool: { toolName: "run_command", summary, preview, fullResult, ok: true, ordinal: 3 },
});

describe("HistoryItem tool headline", () => {
  it("keeps a long command on one row instead of wrapping it", () => {
    const command = `git -C D:/project/git/benchmark show HEAD:${"results/debug/report".repeat(12)}`;
    const lines = renderTurn(toolTurn(`[Tools] run_command → ${command}`));

    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThanOrEqual(COLUMNS);
  });

  it("keeps the marker and ordinal intact when the summary overflows", () => {
    const lines = renderTurn(toolTurn(`[Tools] run_command → ${"x".repeat(400)}`));

    // Yoga shrinks flexible siblings before it truncates; without a pinned
    // prefix this rendered as "●#3" with the spaces eaten.
    expect(lines[0]).toMatch(/^● #3 \[Tools\] run_command → x+…$/);
  });

  it("does not truncate the preview rows under the headline", () => {
    const lines = renderTurn(toolTurn("[Tools] run_command → ls", "one\ntwo", "one\ntwo"));

    expect(lines.slice(1)).toEqual(["  one", "  two"]);
  });
});
