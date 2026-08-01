import { link as terminalLink } from "ansi-escapes";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import wrapAnsi from "wrap-ansi";
import { wrapRows } from "../prompt-editor/softWrap";

const OPTIONS = { hard: true, trim: false } as const;
const FORBIDDEN_LINE_START =
  /^[!%),.:;?\]}\u00BB\u2019\u201D\u3001\u3002\u3009\u300B\u300D\u300F\u3011\u3015\u3017\u3019\u301B\uFF01\uFF05\uFF09\uFF0C\uFF0E\uFF1A\uFF1B\uFF1F\uFF3D\uFF5D]/u;
const FORBIDDEN_LINE_END =
  /[[({\u00AB\u2018\u201C\u3008\u300A\u300C\u300E\u3010\u3014\u3016\u3018\u301A\uFF08\uFF3B\uFF5B]$/u;

const SCREENSHOT_PROSE =
  "有一点要注意：在这个环境里，同一个回合内我可以在一条消息里带多个工具调用" +
  "（比如刚才同时调 grep 和 list_directory），但思考文本和工具调用不会真正并行流式输出" +
  "——它们只是被合并进同一条 assistant 消息。真正的「边思考边输出」只有 reasoning " +
  "模型自己才做得到，而且那是模型内部行为，不会通过工具结果返回给你。";

function visibleLines(value: string): string[] {
  return value.split("\n").map((line) => stripAnsi(line));
}

describe("patched wrap-ansi CJK wrapping", () => {
  it("fills mixed CJK/Latin prose instead of moving a whole Chinese clause", () => {
    const lines = visibleLines(wrapAnsi(SCREENSHOT_PROSE, 100, OPTIONS));

    expect(lines.map((line) => stringWidth(line))).toEqual([97, 99, 99, 4]);
    expect(lines.join("")).toBe(SCREENSHOT_PROSE);
    expect(lines.slice(0, -1).every((line) => stringWidth(line) >= 90)).toBe(true);
  });

  it("keeps segmented Chinese words and paired punctuation together when they fit", () => {
    const lines = visibleLines(wrapAnsi("测试（合并），继续处理消息。", 10, OPTIONS));

    expect(lines).toContain("（合并），");
    for (const line of lines) {
      expect(line).not.toMatch(FORBIDDEN_LINE_START);
      expect(line).not.toMatch(FORBIDDEN_LINE_END);
      expect(stringWidth(line)).toBeLessThanOrEqual(10);
    }
  });

  it("preserves the existing ASCII word-wrap behavior", () => {
    // trim:false deliberately parks the source spaces at the preceding rows.
    expect(wrapAnsi("abcde fghij klmno", 10, OPTIONS)).toBe("abcde \nfghij \nklmno");
    expect(wrapAnsi("a  b ", 20, OPTIONS)).toBe("a  b ");
  });

  it("keeps SGR styles and OSC 8 hyperlinks valid across CJK breaks", () => {
    const styled = `\u001B[31m中文合并测试\u001B[39m ${terminalLink("文档链接", "https://example.com/a")}`;
    const wrapped = wrapAnsi(styled, 8, OPTIONS);
    const lines = visibleLines(wrapped);

    expect(lines.join("")).toBe("中文合并测试 文档链接");
    expect(lines.every((line) => stringWidth(line) <= 8)).toBe(true);
    expect(wrapped).toContain("https://example.com/a");
    expect(wrapped).toContain("\u001B[31m");
  });

  it("keeps prompt wrapping lossless so caret offsets remain source offsets", () => {
    const input = "在一条消息里调用 grep 和 list_directory，然后继续";
    const rows = wrapRows(input, 16);

    expect(rows.map((row) => row.text).join("")).toBe(input);
    expect(rows.map((row) => row.start)).toEqual(
      rows.map((_, index) => rows.slice(0, index).reduce((sum, row) => sum + row.text.length, 0)),
    );
  });
});
