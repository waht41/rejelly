import { renderToString } from "ink";
import { createElement } from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Turn } from "../store/useOutputStore";
import { HistoryItem } from "./HistoryItem";

const COLUMNS = 60;

// HistoryItem sizes itself from useStdout(), which renderToString does not
// provide — its `columns` option only sets the Yoga root. Both have to agree or
// the component pins a width the render surface does not have.
let realColumns: number | undefined;
beforeEach(() => {
  realColumns = process.stdout.columns;
  process.stdout.columns = COLUMNS;
});
afterEach(() => {
  process.stdout.columns = realColumns as number;
});

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

  it("keeps every emitted row inside the terminal width", () => {
    // <Static> sizes children to their content, so an unpinned row is measured
    // against the full width and then pushed past it by its siblings — the
    // terminal wraps what Ink thought had fit.
    const lines = renderTurn(
      toolTurn(
        `[Tools] run_command → ${"cd D:/project && git show HEAD:".repeat(8)}`,
        `{"schema":"tura.benchmark.agent-round.v1","roundId":"${"x".repeat(200)}"}\nshort`,
        "a\nb\nc\nd\ne",
      ),
    );

    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(COLUMNS);
    }
  });

  it("gives each preview line one row and keeps the count line", () => {
    const lines = renderTurn(
      toolTurn("[Tools] run_command → ls", `${"j".repeat(300)}\nshort`, "a\nb\nc\nd"),
    );

    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^ {2}j+…$/);
    expect(lines[2]).toBe("  short");
    expect(lines[3]).toBe("  … (+2 lines, #3)");
  });
});

describe("HistoryItem system turn", () => {
  const systemTurn = (content: string, oneLine?: boolean): Turn => ({
    id: "s_1",
    type: "system",
    content,
    oneLine,
  });

  it("truncates a notice to one row", () => {
    const lines = renderTurn(
      systemTurn(`[Auto-allowed] declared read_only — reason → ${"cmd ".repeat(60)}`, true),
    );

    expect(lines.filter((line) => line.trim().length > 0)).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThanOrEqual(COLUMNS);
  });

  it("wraps ordinary system content, which /expand-tool relies on", () => {
    const lines = renderTurn(systemTurn(`#3 run_command\n${"detail ".repeat(40)}`));

    expect(lines.filter((line) => line.trim().length > 0).length).toBeGreaterThan(2);
    expect(lines.join("\n")).toContain("#3 run_command");
  });
});
