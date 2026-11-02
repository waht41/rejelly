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

describe("HistoryItem user message", () => {
  function renderUser(content: string, columns: number): string {
    const turn = Object.freeze({ id: "u_1", type: "user" as const, content });
    return renderToString(
      createElement(Static, {
        items: [turn],
        children: () => createElement(HistoryItem, { key: turn.id, turn, columns }),
      }),
      { columns },
    );
  }

  it("renders pasted code with four-column tab stops without changing the source", () => {
    const content =
      "\t// 点赞\n\tconst sql = `\n\t\tSELECT user_id\n\n\t\tFROM like_relation\n\t`;\n中\tA\tB\n1234\tend\n🙂\tend";
    const lines = stripAnsi(renderUser(content, 40)).split("\n");

    expect(lines.map((line) => line.trimEnd())).toEqual([
      " ❯     // 点赞",
      "     const sql = `",
      "         SELECT user_id",
      "",
      "         FROM like_relation",
      "     `;",
      " 中  A   B",
      " 1234    end",
      " 🙂  end",
      "",
    ]);
  });

  it("never emits cursor-moving tabs or rows wider than the terminal", () => {
    const content = `\t// ${"并发点赞 query ".repeat(20)}\n\t\tSELECT user_id\n\t\tFROM like_relation`;
    for (const columns of [20, 40, 80]) {
      const output = renderUser(content, columns);
      expect(output).not.toContain("\t");
      for (const line of stripAnsi(output).split("\n")) {
        expect(stringWidth(line)).toBeLessThanOrEqual(columns);
      }
    }
  });
});

describe("pending input preview", () => {
  it("previews paste and attachment failures while pending but prints their full source in history", () => {
    const attachments = [
      { type: "image" as const, label: "[Image #1]", action: "attach" as const },
      {
        type: "file" as const,
        label: "missing.ts",
        action: "attach" as const,
        status: "error" as const,
      },
    ];
    const turn: Turn = {
      id: "submitted",
      type: "user",
      content:
        "Inspect logs\nprivate paste body\n  -> attach [Image #1]\n  -> attach missing.ts failed",
      presentation: { summary: "Inspect logs\n[Paste · 30 lines]", attachments },
    };
    const output = stripAnsi(
      renderToString(createElement(HistoryItem, { turn, columns: COLUMNS, userMaxRows: 8 }), {
        columns: COLUMNS,
      }),
    );
    expect(output).toContain("❯ Inspect logs");
    expect(output).toContain("[Paste · 30 lines]");
    expect(output).toContain("Failed: 1/2 attachments · missing.ts");
    expect(output).not.toContain("… folded");
    expect(output).not.toContain("private paste body");
    const committed = renderTurn(turn).join("\n");
    expect(committed).toContain("private paste body");
    expect(committed).toContain("attach missing.ts failed");
    expect(committed).not.toContain("[Paste · 30 lines]");
    expect(committed).not.toContain("folded");
  });

  it("uses one separator without blank gaps around the cut in a plan followed by a short request", () => {
    const content = `计划:\n\n1. First requirement\n\n${Array.from({ length: 12 }, (_, i) => `Middle evidence ${i}`).join("\n")}\n\n\nhello\n\n`;
    const turn: Turn = { id: "plan", type: "user", content };
    const output = stripAnsi(
      renderToString(createElement(HistoryItem, { turn, columns: COLUMNS, userMaxRows: 8 }), {
        columns: COLUMNS,
      }),
    );
    const lines = output
      .trimEnd()
      .split("\n")
      .map((line) => line.trim());
    const separator = lines.findIndex((line) => line.includes("rows folded"));
    expect(output.match(/rows folded/g)).toHaveLength(1);
    expect(lines[separator]).toMatch(/^─ \d+ rows folded ─+$/);
    expect(lines[separator - 1]).toBe("1. First requirement");
    expect(lines[separator + 1]).toBe("hello");
    expect(lines.at(-1)).toBe("hello");
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(turn.content).toBe(content);
  });

  it("bounds wrapped CJK, emoji, and tabs while retaining a marked beginning and ending", () => {
    const content = `开始\t${"并发 query 🙂 ".repeat(50)}\n最终问题`;
    const turn: Turn = {
      id: "wide",
      type: "user",
      content,
      presentation: { summary: content, attachments: [] },
    };
    for (const columns of [20, 40, 80]) {
      const output = stripAnsi(
        renderToString(createElement(HistoryItem, { turn, columns, userMaxRows: 8 }), { columns }),
      );
      const lines = output.trimEnd().split("\n");
      expect(lines.length).toBeLessThanOrEqual(8);
      expect(output).toContain("❯ 开始");
      expect(output).toContain("最终问题");
      expect(output.match(/rows folded/g)).toHaveLength(1);
      expect(output).not.toContain("… folded");
      expect(output).not.toContain("\t");
      for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
      expect(turn.content).toBe(content);
    }
  });
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

  it("keeps auto-approval safety and reason on one row inside the tool block", () => {
    const turn = toolTurn("[Tools] run_command → rg declaredSafety");
    if (turn.type !== "tool") {
      throw new Error("Expected tool turn");
    }
    turn.tool.approval = {
      mode: "auto",
      basis: "read_only",
      reason: "Find where shell safety metadata is processed.",
    };

    const lines = renderTurn(turn);
    expect(lines[0]).toBe("● #3 [Tools] run_command → rg declaredSafety");
    expect(lines[1]).toMatch(/^ {2}auto · read_only — Find where shell safety metadata is pr…$/);
    expect(lines).toHaveLength(2);
  });

  it("labels mode-independent safe commands as host policy", () => {
    const turn = toolTurn("[Tools] run_command → git status");
    if (turn.type !== "tool") {
      throw new Error("Expected tool turn");
    }
    turn.tool.approval = { mode: "policy", basis: "read_only" };

    expect(renderTurn(turn)).toEqual([
      "● #3 [Tools] run_command → git status",
      "  policy · read_only",
    ]);
  });

  it("labels accepted manual approval and keeps its reason on the same row", () => {
    const turn = toolTurn("[Tools] run_command → pnpm test");
    if (turn.type !== "tool") {
      throw new Error("Expected tool turn");
    }
    turn.tool.approval = {
      mode: "manual",
      basis: "reversible",
      reason: "Run the package tests.",
    };

    expect(renderTurn(turn)).toEqual([
      "● #3 [Tools] run_command → pnpm test",
      "  approved · reversible — Run the package tests.",
    ]);
  });

  it("omits trivial manual write approval without a reason", () => {
    const turn = toolTurn("[Tools] edit_file → src/a.ts");
    if (turn.type !== "tool") {
      throw new Error("Expected tool turn");
    }
    turn.tool.approval = { mode: "manual", basis: "edit" };

    expect(renderTurn(turn)).toEqual(["● #3 [Tools] edit_file → src/a.ts"]);
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
