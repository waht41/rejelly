import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement } from "react";
import stripAnsi from "strip-ansi";
import { expect, it, vi } from "vitest";
import { requestSyntaxHighlighter } from "../../terminal-ui/rich-text/syntaxHighlight";
import type { Turn } from "./model";
import { StaticHistory } from "./StaticHistory";

const highlighter = vi.hoisted(() => ({ ready: false, listeners: new Set<() => void>() }));
vi.mock("../../terminal-ui/rich-text/syntaxHighlight", async (original) => ({
  ...(await original<typeof import("../../terminal-ui/rich-text/syntaxHighlight")>()),
  syntaxHighlighterSnapshot: () => (highlighter.ready ? "ready" : "loading"),
  subscribeSyntaxHighlighter: (listener: () => void) => {
    highlighter.listeners.add(listener);
    return () => highlighter.listeners.delete(listener);
  },
  requestSyntaxHighlighter: vi.fn(),
}));

it("holds a syntax-blocked history suffix even when highlighting finishes while the primary screen is paused", async () => {
  const stdin = new PassThrough();
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true });
  let output = "";
  stdout.on("data", (chunk) => {
    output += stripAnsi(String(chunk));
  });
  const turns: Turn[] = [
    { id: "old", type: "system", content: "Already committed sentinel" },
    { id: "code", type: "assistant", content: "```ts\nconst delayedSentinel = true;\n```" },
  ];
  const instance = render(createElement(StaticHistory, { turns, columns: 80 }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    interactive: true,
    patchConsole: false,
  });
  try {
    await instance.waitUntilRenderFlush();
    expect(requestSyntaxHighlighter).toHaveBeenCalled();
    expect(output).toContain("Already committed sentinel");
    expect(output).not.toContain("delayedSentinel");

    const next: Turn[] = [...turns, { id: "new", type: "system", content: "New history sentinel" }];
    instance.rerender(createElement(StaticHistory, { turns: next, columns: 80, paused: true }));
    highlighter.ready = true;
    for (const listener of highlighter.listeners) listener();
    await instance.waitUntilRenderFlush();
    expect(output).not.toContain("delayedSentinel");
    expect(output).not.toContain("New history sentinel");

    instance.rerender(createElement(StaticHistory, { turns: next, columns: 80 }));
    await instance.waitUntilRenderFlush();
    for (const text of ["Already committed sentinel", "delayedSentinel", "New history sentinel"]) {
      expect(output.split(text)).toHaveLength(2);
    }
  } finally {
    instance.unmount();
    stdin.destroy();
    stdout.destroy();
  }
});
