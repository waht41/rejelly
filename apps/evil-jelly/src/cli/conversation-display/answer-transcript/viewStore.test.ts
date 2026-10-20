import { beforeEach, describe, expect, it } from "vitest";
import type { TranscriptItem } from "../../../shared/session/transcript";
import { buildAnswerTranscript, filterAnswerTranscript } from "./projection";
import { resetAnswerTranscriptSession, useAnswerTranscriptStore } from "./viewStore";

beforeEach(resetAnswerTranscriptSession);

const transcript: TranscriptItem[] = [
  {
    id: "u",
    type: "user",
    turnId: "t",
    seq: 1,
    content: "Question",
    inputKind: "initial",
    turnStatus: "completed",
  },
  { id: "a1", type: "assistant", turnId: "t", seq: 2, content: "Checking", hasToolCalls: true },
  { id: "s", type: "system", turnId: "t", seq: 3, kind: "error", content: "Old failed attempt" },
  {
    id: "steer",
    type: "user",
    turnId: "t",
    seq: 4,
    inputKind: "steer",
    content: "Also check tests",
  },
  {
    id: "a2",
    type: "assistant",
    turnId: "t",
    seq: 5,
    content: "## Final\n```ts\nconst x = 1;\n```",
  },
];

describe("answer transcript", () => {
  it("groups steers and tool rounds under the real turn and respects its latest lifecycle", () => {
    expect(buildAnswerTranscript(transcript)).toEqual([
      {
        id: "t",
        prompt: "Question",
        answer: "## Final\n```ts\nconst x = 1;\n```",
        status: "completed",
      },
    ]);
    expect(buildAnswerTranscript(transcript.slice(0, 2))[0]?.answer).toBe("");
  });

  it("labels legacy and interrupted history without inventing a completed answer", () => {
    const items: TranscriptItem[] = [
      { id: "u", type: "user", turnId: "legacy:0:1", seq: 1, content: "Old question" },
      { id: "a", type: "assistant", turnId: "legacy:0:1", seq: 2, content: "Old answer" },
      {
        id: "u2",
        type: "user",
        turnId: "t2",
        seq: 3,
        content: "New question",
        turnStatus: "interrupted",
        inputKind: "initial",
      },
      {
        id: "a2",
        type: "assistant",
        turnId: "t2",
        seq: 4,
        content: "Partial plan",
        hasToolCalls: true,
      },
    ];
    expect(buildAnswerTranscript(items)).toEqual([
      { id: "legacy:0:1", prompt: "Old question", answer: "Old answer", status: "unknown" },
      { id: "t2", prompt: "New question", answer: "Partial plan", status: "interrupted" },
    ]);
  });

  it("keeps all resumed answers independently of the ten-turn scrollback limit", () => {
    const items = Array.from({ length: 12 }, (_, index) =>
      transcript
        .filter((item) => item.type !== "system")
        .map((item) => ({ ...item, id: `${index}:${item.id}`, turnId: `turn-${index}` })),
    );
    useAnswerTranscriptStore.getState().hydrate(items.flat());
    const entries = useAnswerTranscriptStore.getState().entries;
    expect(entries).toHaveLength(12);
    expect(filterAnswerTranscript(entries, "const x")).toHaveLength(12);
    expect(filterAnswerTranscript(entries, "QUESTION")[0]?.id).toBe("turn-11");
    expect(filterAnswerTranscript(entries, "not present")).toEqual([]);
  });

  it("archives the full reply without duplicating streams, retries, or continuation turns", () => {
    const store = useAnswerTranscriptStore.getState();
    store.updateTurn({ turnId: "t", prompt: "Question", status: "running" });
    store.updateTurn({ turnId: "t", status: "error" });
    store.updateTurn({ turnId: "t", status: "running" });
    store.updateTurn({ turnId: "t", status: "completed", answer: "## Entire answer\n" });
    expect(useAnswerTranscriptStore.getState().entries).toEqual([
      { id: "t", prompt: "Question", answer: "## Entire answer\n", status: "completed" },
    ]);
  });

  it("opens the latest ended turn, preserves its identity and source position across new output", () => {
    const store = useAnswerTranscriptStore.getState();
    store.updateTurn({ turnId: "t1", prompt: "First", answer: "Answer", status: "completed" });
    store.updateTurn({ turnId: "t2", prompt: "Second", status: "running" });
    store.openTranscript();
    expect(useAnswerTranscriptStore.getState().selectedId).toBe("t1");
    store.setAnchor({ line: 4, offset: 12 });
    store.updateTurn({ turnId: "t2", answer: "New answer", status: "completed" });
    store.closeTranscript();
    store.openTranscript();
    expect(useAnswerTranscriptStore.getState()).toMatchObject({
      selectedId: "t1",
      anchor: { line: 4, offset: 12 },
    });
    store.select("t2");
    expect(useAnswerTranscriptStore.getState().anchor).toEqual({ line: 0, offset: 0 });
  });

  it("keeps question and answer bookmarks independent across toggles and reopening", () => {
    const store = useAnswerTranscriptStore.getState();
    store.updateTurn({
      turnId: "t1",
      prompt: "Full paste",
      promptSummary: "[Paste · 1 line]",
      status: "completed",
      answer: "Answer",
    });
    store.updateTurn({ turnId: "t1", status: "completed" });
    expect(useAnswerTranscriptStore.getState().entries[0]?.promptSummary).toBe("[Paste · 1 line]");
    store.openTranscript();
    store.setAnchor({ line: 8, offset: 4 });
    store.setDetail("question");
    store.setQuestionAnchor({ line: 3, offset: 12 });
    store.closeTranscript();
    store.openTranscript();
    expect(useAnswerTranscriptStore.getState()).toMatchObject({
      detail: "question",
      anchor: { line: 8, offset: 4 },
      questionAnchor: { line: 3, offset: 12 },
    });
    store.setDetail("answer");
    expect(useAnswerTranscriptStore.getState().anchor).toEqual({ line: 8, offset: 4 });
    store.updateTurn({ turnId: "t2", prompt: "Second", status: "completed" });
    store.select("t2");
    expect(useAnswerTranscriptStore.getState()).toMatchObject({
      anchor: { line: 0, offset: 0 },
      questionAnchor: { line: 0, offset: 0 },
    });
    store.hydrate([
      {
        id: "u",
        type: "user",
        turnId: "restored",
        seq: 1,
        content: "Full paste",
        promptSummary: "[Paste · 1 line]",
      },
    ]);
    expect(useAnswerTranscriptStore.getState().entries[0]).toMatchObject({
      prompt: "Full paste",
      promptSummary: "[Paste · 1 line]",
    });
    expect(
      filterAnswerTranscript(useAnswerTranscriptStore.getState().entries, "Full paste"),
    ).toHaveLength(1);
    resetAnswerTranscriptSession();
    expect(useAnswerTranscriptStore.getState()).toMatchObject({
      detail: "answer",
      anchor: { line: 0, offset: 0 },
      questionAnchor: { line: 0, offset: 0 },
    });
  });

  it("resets answers and bookmarks on clear or hydration of a different session", () => {
    const store = useAnswerTranscriptStore.getState();
    store.hydrate(transcript);
    store.openTranscript();
    store.setQuery("question");
    resetAnswerTranscriptSession();
    expect(useAnswerTranscriptStore.getState()).toMatchObject({
      entries: [],
      selectedId: null,
      open: false,
      query: "",
    });
    store.hydrate(transcript);
    store.openTranscript();
    store.hydrate([]);
    expect(useAnswerTranscriptStore.getState()).toMatchObject({
      entries: [],
      selectedId: null,
      open: false,
    });
  });
});
