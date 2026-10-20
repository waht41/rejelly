import { type Key, renderToString } from "ink";
import { createElement } from "react";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnswerTranscriptOverlay } from "./AnswerTranscriptOverlay";
import { resetAnswerTranscriptSession, useAnswerTranscriptStore } from "./viewStore";

const input = vi.hoisted(() => ({
  handler: (_text: string, _key: Partial<Key>) => {},
  columns: 80,
  rows: 12,
}));
vi.mock("ink", async (original) => ({
  ...(await original<typeof import("ink")>()),
  useInput: (handler: typeof input.handler) => {
    input.handler = handler;
  },
  useWindowSize: () => ({ columns: input.columns, rows: input.rows }),
}));

beforeEach(() => {
  resetAnswerTranscriptSession();
  input.columns = 80;
  input.rows = 12;
});

function paint(copyText = vi.fn(async (_text: string) => {})): string[] {
  return stripAnsi(
    renderToString(createElement(AnswerTranscriptOverlay, { copyText }), {
      columns: input.columns,
    }),
  ).split("\n");
}

describe("answer transcript reader", () => {
  it("draws only a viewport of Markdown source and scrolls to the end", () => {
    const store = useAnswerTranscriptStore.getState();
    store.updateTurn({
      turnId: "t",
      prompt: "Question",
      status: "completed",
      answer: Array.from({ length: 100 }, (_, i) => `## Row ${i}`).join("\n"),
    });
    store.openTranscript();
    expect(paint().join("\n")).toContain("## Row 0");
    expect(paint().join("\n")).not.toContain("## Row 99");
    input.handler("", { end: true });
    expect(paint().join("\n")).toContain("## Row 99");
    expect(paint().length).toBeLessThanOrEqual(input.rows + 1);
    expect(paint().every((line) => stringWidth(line) <= input.columns)).toBe(true);
  });

  it("switches turns, copies the unwrapped complete source, and closes without submission", async () => {
    const store = useAnswerTranscriptStore.getState();
    const source = ["```ts", "long source ".repeat(40), "```", ""].join("\n");
    store.updateTurn({ turnId: "t1", prompt: "First", status: "completed", answer: source });
    store.updateTurn({
      turnId: "t2",
      prompt: "Second",
      status: "completed",
      answer: "Second answer",
    });
    store.openTranscript();
    paint();
    input.handler("", { leftArrow: true });
    expect(useAnswerTranscriptStore.getState().selectedId).toBe("t1");
    const copy = vi.fn(async (_text: string) => {});
    paint(copy);
    input.handler("c", {});
    expect(copy).toHaveBeenCalledWith(source);
    input.handler("", { escape: true });
    expect(useAnswerTranscriptStore.getState().open).toBe(false);
  });

  it("uses a filtered newest-first directory and opens the chosen answer", () => {
    const store = useAnswerTranscriptStore.getState();
    store.updateTurn({ turnId: "t1", prompt: "First", status: "completed", answer: "needle" });
    store.updateTurn({ turnId: "t2", prompt: "Second", status: "completed", answer: "other" });
    store.openTranscript();
    store.setQuery("needle");
    store.setMode("list");
    expect(paint().join("\n")).toContain("First");
    expect(paint().join("\n")).not.toContain("Second");
    input.handler("", { return: true });
    expect(useAnswerTranscriptStore.getState()).toMatchObject({ selectedId: "t1", mode: "detail" });
  });

  it("opens complete questions with p and preserves separate reading positions and raw copy", () => {
    const store = useAnswerTranscriptStore.getState();
    const prompt = Array.from({ length: 30 }, (_, i) => `Question row ${i}`).join("\n");
    store.updateTurn({
      turnId: "t",
      prompt,
      status: "completed",
      answer: Array.from({ length: 100 }, (_, i) => `Answer row ${i}`).join("\n"),
    });
    store.openTranscript();
    const preview = paint();
    expect(preview[1]).toBe("You: Question row 0");
    expect(preview[2]).toContain("Question row 1");
    expect(preview[2]).toContain("p full question");
    expect(preview.join("\n")).not.toContain("Question row 29");
    expect(preview.join("\n")).toContain("Answer row 0");
    input.handler("", { end: true });
    const answerAnchor = useAnswerTranscriptStore.getState().anchor;
    paint();
    input.handler("p", {});
    expect(paint().join("\n")).toContain("Transcript · Question");
    expect(paint().join("\n")).toContain("Question row 0");
    expect(paint().join("\n")).not.toContain("Answer row");
    input.handler("", { end: true });
    expect(paint().join("\n")).toContain("Question row 29");
    const questionAnchor = useAnswerTranscriptStore.getState().questionAnchor;
    const copy = vi.fn(async (_text: string) => {});
    paint(copy);
    input.handler("c", {});
    expect(copy).toHaveBeenCalledWith(prompt);
    input.handler("p", {});
    expect(paint().join("\n")).toContain("Answer row 99");
    expect(useAnswerTranscriptStore.getState().anchor).toEqual(answerAnchor);
    input.handler("p", {});
    expect(paint().join("\n")).toContain("Question row 29");
    expect(useAnswerTranscriptStore.getState().questionAnchor).toEqual(questionAnchor);
    store.closeTranscript();
    store.openTranscript();
    input.columns = 32;
    const resized = paint();
    expect(resized.join("\n")).toContain("Question row 29");
    expect(resized.length).toBeLessThanOrEqual(input.rows + 1);
    expect(resized.every((line) => stringWidth(line) <= input.columns)).toBe(true);
  });

  it("uses compact input in previews and the directory but searches and reveals its full source", () => {
    const store = useAnswerTranscriptStore.getState();
    const prompt = "Inspect\n<mcp_reference>pasted trace needle</mcp_reference>\n@file.ts$mcp:docs";
    store.updateTurn({
      turnId: "t",
      prompt,
      promptSummary: "Inspect\n[Paste · 1 line] @file.ts $mcp:docs",
      status: "completed",
      answer: "The answer",
    });
    store.openTranscript();
    expect(paint().join("\n")).toContain("[Paste · 1 line]");
    expect(paint().join("\n")).not.toContain("pasted trace");
    store.setQuery("needle");
    store.setMode("list");
    expect(paint().join("\n")).toContain("[Paste · 1 line]");
    expect(paint().join("\n")).not.toContain("pasted trace");
    input.handler("", { return: true });
    paint();
    input.handler("p", {});
    expect(paint().join("\n")).toContain("<mcp_reference>pasted trace needle</mcp_reference>");
    input.handler("", { tab: true });
    paint();
    input.handler("", { return: true });
    expect(useAnswerTranscriptStore.getState().detail).toBe("answer");
  });

  it("fits narrow terminals and labels running or failed output honestly", () => {
    input.columns = 24;
    input.rows = 8;
    const store = useAnswerTranscriptStore.getState();
    store.updateTurn({ turnId: "t", prompt: "中文问题", status: "running" });
    store.openTranscript();
    expect(paint().every((line) => stringWidth(line) <= input.columns)).toBe(true);
    store.updateTurn({ turnId: "t", status: "interrupted", answer: "partial" });
    expect(paint().join("\n")).toContain("partial");
    expect(paint().join("\n")).toContain("interrupted");
  });
});
