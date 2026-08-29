import { renderToString, Static } from "ink";
import { createElement } from "react";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { HistoryItem } from "./HistoryItem";
import type { Turn } from "./model";

const COLUMNS = 60;

function renderTurn(turn: Turn): string[] {
  const output = renderToString(createElement(HistoryItem, { turn, columns: COLUMNS }), {
    columns: COLUMNS,
  });
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

  it("counts withheld characters when no whole line was omitted", () => {
    // One enormous line: the preview is cut on characters, not lines, so a line
    // count has nothing to report and used to render "+0 lines".
    const fullResult = `exitCode=0 status=ok\n${"A".repeat(5000)}`;
    const preview = `${fullResult.slice(0, 600)}\n…`;
    const lines = renderTurn(toolTurn("[Tools] run_command → node -e ...", preview, fullResult));

    expect(lines.at(-1)).toMatch(/^ {2}… \(\+4\.\dk chars, #3\)$/);
  });

  it("shows applied auto-mode diffs inline without a frame", () => {
    const turn = toolTurn("[Tools] edit_file → a.ts", "Updated a.ts.", "Updated a.ts.");
    if (turn.type !== "tool") {
      throw new Error("Expected tool turn");
    }
    turn.tool.detail = {
      type: "diff",
      text: "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new",
      phase: "applied",
      presentation: "inline",
    };

    const output = renderTurn(turn).join("\n");

    expect(output).toContain("Changes · 1 file · +1 −1");
    expect(output).toContain("a.ts");
    expect(output).toContain("- old");
    expect(output).toContain("+ new");
    expect(output).not.toContain("╭");
    expect(output).not.toContain("╰");
  });

  it("does not repeat confirmation diffs or inline uncommitted proposals", () => {
    for (const detail of [
      { phase: "applied" as const, presentation: "expanded" as const },
      { phase: "proposed" as const, presentation: "inline" as const },
    ]) {
      const turn = toolTurn("[Tools] edit_file → a.ts", "Updated a.ts.", "Updated a.ts.");
      if (turn.type !== "tool") {
        throw new Error("Expected tool turn");
      }
      turn.tool.detail = {
        type: "diff",
        text: "--- a.ts\n+++ a.ts\n@@\n-old\n+new",
        ...detail,
      };

      expect(renderTurn(turn).join("\n")).not.toContain("Changes");
    }
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

describe("HistoryItem assistant markdown", () => {
  const assistantTurn = (content: string): Turn => ({ id: "a_1", type: "assistant", content });

  // Long enough that every wrap point lands mid-sentence, mixing CJK with ASCII identifiers the
  // way model prose does.
  const longItem =
    "1. **`status` 现在是死数据** —— 全仓库没有任何 UI 读 `status` 字段。" +
    "`confirmWrite.ts`/`getInput.ts` 里精心构造的 `shell → workspace root` 都写进 store 后无人消费。";

  /**
   * Through `<Static>`, which is the only way this defect appears: Static sizes its children by
   * their content rather than by the terminal, so a Box with no pinned width lets a paragraph
   * measure itself against its *unwrapped* text. Rendering HistoryItem on its own puts it at the
   * root, where it inherits the terminal width and looks fine either way.
   */
  function renderThroughStatic(content: string, columns: number): string[] {
    const output = renderToString(
      createElement(Static, {
        items: [assistantTurn(content)],
        children: (turn: unknown) =>
          createElement(HistoryItem, { key: "a_1", turn: turn as Turn, columns }),
      }),
      { columns },
    );
    return stripAnsi(output).split("\n");
  }

  it("never emits a row wider than the terminal", () => {
    // An over-wide row is left for the terminal to soft-wrap, which it does at the column edge:
    // mid-token, landing at column 0 with none of this layout's indentation.
    for (const columns of [60, 80, 100, 120, 140]) {
      for (const line of renderThroughStatic(longItem, columns)) {
        expect(stringWidth(line)).toBeLessThanOrEqual(columns);
      }
    }
  });

  it("keeps the space after a list marker", () => {
    // Once the row is width-constrained, Yoga balances an over-wide line by shrinking the marker
    // instead of wrapping the text further, turning "1. status" into "1.status".
    for (const columns of [60, 80, 100, 120, 140]) {
      expect(renderThroughStatic(longItem, columns).join("\n")).toContain("1. ");
    }
  });
});
