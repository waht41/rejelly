import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement } from "react";
import stripAnsi from "strip-ansi";
import { expect, it, vi } from "vitest";
import { ActionMenuPrompt } from "./ActionMenuPrompt";

class MenuInput extends PassThrough {
  isTTY = true;
  setRawMode() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

it("keeps every visible choice on one row and highlights the next choice after one Down press", async () => {
  const longTitle = "很长的会话标题 ".repeat(4).trim();
  const options = Array.from({ length: 12 }, (_, index) => {
    const title =
      index < 2 ? `Session ${index + 1}` : index === 8 ? "First line\nSecond line" : longTitle;
    return {
      key: index < 9 ? String(index + 1) : "",
      label: `2026/10/21 17:59:28  (2 turns)  ${title}`,
      value: `session-${index + 1}`,
    };
  });
  const stdin = new MenuInput();
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true });
  const onSelect = vi.fn();
  let frame = "";
  stdout.on("data", (chunk) => {
    frame = stripAnsi(String(chunk));
  });
  const instance = render(
    createElement(ActionMenuPrompt, { message: "Resume which session?", options, onSelect }),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  try {
    await vi.waitFor(() => expect(frame).toContain("▸ [1]"));
    const lines = frame.split("\n");
    const firstOption = lines.findIndex((line) => line.startsWith("▸ [1]"));
    const overflow = lines.indexOf("... and 3 more");
    expect(overflow - firstOption).toBe(9);
    expect(lines[overflow - 1]).toContain("First line Second line");
    expect(lines.slice(firstOption, overflow).map((line) => line.match(/\[\d\]/)?.[0])).toEqual([
      "[1]",
      "[2]",
      "[3]",
      "[4]",
      "[5]",
      "[6]",
      "[7]",
      "[8]",
      "[9]",
    ]);

    stdin.write("\u001b[B");
    await vi.waitFor(() => expect(frame).toContain("▸ [2]"));
    stdin.write("\r");
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith("session-2"));
  } finally {
    instance.unmount();
    stdin.destroy();
    stdout.destroy();
  }
});
