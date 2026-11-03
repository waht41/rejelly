import { PassThrough } from "node:stream";
import type { ModelAdapter, StreamEvent } from "@rejelly/core";
import { render } from "ink";
import { createElement } from "react";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as userInputRepository from "../../domains/session/repository/userInputRepository";
import type { EvilJellyBindings } from "../../shared/host/bindings";
import { type PromptInput, textPromptInput } from "../../shared/model/prompt/promptInput";
import {
  resetAnswerTranscriptSession,
  useAnswerTranscriptStore,
} from "../conversation-display/answer-transcript/viewStore";
import { resetToolTranscriptViewSession } from "../conversation-display/tool-transcript/viewStore";
import { resetOutputSession, useOutputStore } from "../conversation-display/useOutputStore";
import {
  resetComposerSession,
  useComposerSession,
} from "../message-composer/session/composerSession";
import { useDecisionStore } from "../operator-decision/decisionStore";
import { resetSubmissionDispatch } from "../submission-dispatch/dispatcher";
import { createInteractiveRunControl } from "../unified-conversation/interactive/runControl";
import { runEvilJellyHost } from "../unified-conversation/interactive/runSegment";
import { copyTextToClipboard } from "./clipboard/clipboardText";
import { Dashboard } from "./Dashboard";
import { createInteractiveSubmission } from "./submission";

const mounts = vi.hoisted(() => ({ history: 0 }));
vi.mock("../conversation-display/history/StaticHistory", async (original) => {
  const { StaticHistory } =
    await original<typeof import("../conversation-display/history/StaticHistory")>();
  const React = await import("react");
  return {
    StaticHistory: (props: Parameters<typeof StaticHistory>[0]) => {
      React.useEffect(() => {
        mounts.history++;
      }, []);
      return React.createElement(StaticHistory, props);
    },
  };
});
vi.mock("./clipboard/clipboardText", () => ({ copyTextToClipboard: vi.fn(async () => {}) }));

class Input extends PassThrough {
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

let instance: ReturnType<typeof render> | undefined;
let stdin: Input;
let stdout: PassThrough & { columns: number; rows: number; isTTY: boolean };
let output = "";
// Ink debug writes the complete Static backlog + dynamic frame on each render. A withdrawn
// input accidentally flushed to <Static> remains here even if the store later filters it out.
let lastFrame = "";

beforeEach(() => {
  resetSubmissionDispatch();
  resetOutputSession();
  resetAnswerTranscriptSession();
  resetToolTranscriptViewSession();
  resetComposerSession();
  useDecisionStore.setState({ decision: { type: "idle" }, view: { type: "none" } });
  mounts.history = 0;
  output = "";
  lastFrame = "";
  stdin = new Input();
  stdout = Object.assign(new PassThrough(), { columns: 100, rows: 24, isTTY: true });
  stdout.on("data", (chunk) => {
    lastFrame = stripAnsi(String(chunk));
    output += lastFrame;
  });
});

afterEach(() => {
  instance?.unmount();
  instance = undefined;
  stdin.destroy();
  stdout.destroy();
  resetComposerSession();
  resetAnswerTranscriptSession();
  resetToolTranscriptViewSession();
  resetOutputSession();
  resetSubmissionDispatch();
});

function mountDashboard(): void {
  instance = render(createElement(Dashboard, { onCtrlCAbort: vi.fn() }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
}

it("removes a withdrawn input without shrinking Static history or hiding the next answer", async () => {
  const store = useOutputStore.getState();
  const start = (turnId: string, prompt: string) => {
    store.beginTurn();
    store.updateTranscriptTurn({ turnId, status: "running", prompt });
    store.logUser(prompt);
  };
  start("kept", "Same question");
  store.logAssistant("Earlier answer");
  store.updateTranscriptTurn({ turnId: "kept", status: "completed" });
  mountDashboard();
  await vi.waitFor(() => expect(lastFrame).toContain("Earlier answer"));

  start("withdrawn", "Same question");
  await vi.waitFor(() => expect(lastFrame.match(/Same question/g)).toHaveLength(2));
  expect(lastFrame.split("\n").map((line) => line.trim())).toContain("Pending input");
  store.logSystem("Interrupted active task.");
  await vi.waitFor(() => expect(lastFrame).toContain("Interrupted active task."));
  store.logSystem("Input withdrawn.");
  store.updateTranscriptTurn({ turnId: "withdrawn", status: "interrupted", withdrawn: true });
  await vi.waitFor(() => {
    expect(lastFrame).toContain("Input withdrawn.");
    expect(lastFrame.match(/Same question/g)).toHaveLength(1);
    expect(lastFrame.split("\n").map((line) => line.trim())).not.toContain("Pending input");
  });
  expect(lastFrame.match(/Earlier answer/g)).toHaveLength(1);

  start("next", "Next question");
  store.updateTranscriptTurn({ turnId: "next", status: "running", hasProgress: true });
  store.appendStream("Uncommitted partial output\n");
  await vi.waitFor(() => expect(lastFrame).toContain("Uncommitted partial output"));
  expect(useOutputStore.getState().pendingInput).toBeNull();
  store.logAssistant("Uncommitted partial output\nNext answer");
  store.updateTranscriptTurn({ turnId: "next", status: "completed" });
  await vi.waitFor(() => expect(lastFrame).toContain("Next answer"));
  for (const text of ["Same question", "Earlier answer", "Next question", "Next answer"]) {
    expect(lastFrame.split(text)).toHaveLength(2);
  }
  expect(mounts.history).toBe(1);
});

it("retains the input and flushes stable Markdown during a direct reply before it finishes", async () => {
  const store = useOutputStore.getState();
  const prompt = "Direct reply question sentinel";
  const stable = `${Array.from({ length: 20 }, (_, i) => `Stable paragraph ${i}.\n\n`).join("")}\`\`\`ts\nconst ok = true;\n\`\`\`\n\n`;
  let finishReply = () => {};
  const replyGate = new Promise<void>((resolve) => {
    finishReply = resolve;
  });
  const model: ModelAdapter = {
    id: "direct-streaming-reply",
    async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: "text", content: `${stable}Unfinished **tail` };
      await replyGate;
      yield { type: "text", content: "** done." };
    },
  };
  const inputs = [prompt, "/exit"];
  const bindings: EvilJellyBindings = {
    getInput: async () => textPromptInput(inputs.shift() ?? "/exit"),
    printOut: store.appendStream,
    logUserMessage: store.logUser,
    logAssistantMessage: store.logAssistant,
    logSystemEvent: store.logSystem,
    logToolBlock: () => {},
    onTranscriptTurn: store.updateTranscriptTurn,
    onTurnStart: store.beginTurn,
    onPhaseUpdate: store.setPhase,
    confirmTool: async () => ({ action: "accept" }),
    requestChoice: async ({ options }) => options[0]?.value ?? "",
  };
  mountDashboard();
  const run = runEvilJellyHost(bindings, {
    runControl: createInteractiveRunControl(),
    model,
    isolateSessionState: true,
  });
  try {
    // The provider is still streaming: no turn_done, tool call, or final reply can release this.
    await vi.waitFor(() => {
      // Static code blocks also wait for the asynchronous syntax highlighter to become ready.
      expect(lastFrame).toContain("Stable paragraph 0.");
      expect(lastFrame).toContain("Stable paragraph 19.");
      expect(lastFrame).toContain("const ok = true;");
      expect(lastFrame).toContain("Unfinished **tail");
    });
    expect(useOutputStore.getState().pendingInput).toBeNull();
    expect(useOutputStore.getState().streamBuffer).toBe("Unfinished **tail");
    expect(lastFrame.match(/Direct reply question sentinel/g)).toHaveLength(1);
    expect(
      useOutputStore
        .getState()
        .history.some((turn) => turn.type === "assistant_stream" && turn.content === stable),
    ).toBe(true);
  } finally {
    finishReply();
    await run;
  }
  await vi.waitFor(() => expect(lastFrame).toContain("done."));
  expect(lastFrame.match(/Direct reply question sentinel/g)).toHaveLength(1);
  expect(lastFrame.match(/Stable paragraph 0\./g)).toHaveLength(1);
  expect(mounts.history).toBe(1);
});

it("keeps long withdrawable input inside the refreshable viewport", async () => {
  const store = useOutputStore.getState();
  mountDashboard();
  await vi.waitFor(() => expect(lastFrame).toContain("Message"));
  const prompt = Array.from({ length: 100 }, (_, i) => `Pending input row ${i}`).join("\n");
  store.beginTurn();
  store.updateTranscriptTurn({ turnId: "long", status: "running", prompt });
  store.logUser(prompt);
  await vi.waitFor(() => {
    const lines = lastFrame.split("\n").map((line) => line.trim());
    expect(lines.filter((line) => line === "Pending input")).toHaveLength(1);
    expect(lines.indexOf("Pending input")).toBeLessThan(lines.indexOf("❯ Pending input row 0"));
    expect(lastFrame).toContain("❯ Pending input row 0");
    expect(lastFrame).toContain("Pending input row 99");
    expect(lastFrame.match(/content folded/g)).toHaveLength(1);
    expect(lastFrame).not.toContain("… folded");
  });
  for (let i = 0; i < 10; i++) store.logSystem(`Preparation notice ${i}`);
  await vi.waitFor(() => {
    expect(lastFrame).toContain("❯ Pending input row 0");
    expect(lastFrame).toContain("Preparation notice 9");
    expect(lastFrame).toContain("earlier notices");
  });
  expect(lastFrame.trimEnd().split("\n").length).toBeLessThanOrEqual(stdout.rows);
  store.logSystem("Input withdrawn.");
  store.updateTranscriptTurn({ turnId: "long", status: "interrupted", withdrawn: true });
  await vi.waitFor(() => expect(lastFrame).not.toContain("Pending input row"));
  expect(lastFrame).toContain("Message");
});

it("previews pending paste, reads its source, and expands it once when assistant output starts", async () => {
  const store = useOutputStore.getState();
  const reader = useAnswerTranscriptStore.getState();
  reader.updateTurn({
    turnId: "old",
    prompt: "Old question",
    answer: "Old answer",
    status: "completed",
  });
  reader.openTranscript();
  reader.closeTranscript();
  const paste = Array.from({ length: 30 }, (_, i) => `Original pasted log ${i}`).join("\n");
  const prompt = `Inspect logs\n${paste}\nFind the cause`;
  const input = {
    document: [
      { type: "text" as const, text: "Inspect logs\n" },
      { type: "token" as const, kind: "paste" as const, text: paste },
      { type: "text" as const, text: "\nFind the cause" },
    ],
    attachments: [],
  };
  let finishReply = () => {};
  const replyGate = new Promise<void>((resolve) => {
    finishReply = resolve;
  });
  let finishTurn = () => {};
  const completionGate = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  const model: ModelAdapter = {
    id: "pending-paste",
    async *stream(): AsyncGenerator<StreamEvent> {
      await replyGate;
      yield { type: "text", content: "Inspection started.\n\n" };
      await completionGate;
      yield { type: "text", content: "Finished inspection." };
    },
  };
  const inputs = [input, textPromptInput("/exit")];
  const bindings: EvilJellyBindings = {
    getInput: async () => inputs.shift() ?? textPromptInput("/exit"),
    printOut: store.appendStream,
    logUserMessage: store.logUser,
    logAssistantMessage: store.logAssistant,
    logSystemEvent: store.logSystem,
    logToolBlock: () => {},
    onTranscriptTurn: (update) => {
      store.updateTranscriptTurn(update);
      reader.updateTurn(update);
    },
    onTurnStart: store.beginTurn,
    onPhaseUpdate: store.setPhase,
    confirmTool: async () => ({ action: "accept" }),
    requestChoice: async ({ options }) => options[0]?.value ?? "",
  };
  mountDashboard();
  const run = runEvilJellyHost(bindings, {
    runControl: createInteractiveRunControl(),
    model,
    isolateSessionState: true,
  });
  try {
    await vi.waitFor(() => expect(lastFrame).toContain("[Paste · 30 lines]"));
    expect(lastFrame).not.toContain("Original pasted log");
    expect(useOutputStore.getState().pendingInput).not.toBeNull();
    stdin.write("\u0014"); // Ctrl+T keeps the previously selected ended turn.
    await vi.waitFor(() => expect(lastFrame).toContain("Old answer"));
    stdin.write("\u001b[C"); // Right: select the running turn.
    await vi.waitFor(() => expect(lastFrame).toContain("This turn is still running."));
    stdin.write("p"); // Read the complete original question.
    await vi.waitFor(() => {
      expect(lastFrame).toContain("Original pasted log 0");
      expect(lastFrame).toContain("Running");
    });
    expect(useAnswerTranscriptStore.getState().detail).toBe("question");
    expect(useAnswerTranscriptStore.getState().selectedId).not.toBe("old");
    stdin.write("c");
    await vi.waitFor(() => expect(copyTextToClipboard).toHaveBeenLastCalledWith(prompt));
    stdin.write("\u0014"); // Ctrl+T closes the reader.
    await vi.waitFor(() => expect(lastFrame).toContain("[Paste · 30 lines]"));
    expect(lastFrame).not.toContain("Original pasted log");
    finishReply();
    await vi.waitFor(() => {
      expect(lastFrame).toContain("Inspection started.");
      expect(lastFrame).toContain("Original pasted log 15");
      expect(lastFrame).not.toContain("[Paste · 30 lines]");
    });
    expect(useOutputStore.getState().pendingInput).toBeNull();
    expect(lastFrame.split("\n").map((line) => line.trim())).not.toContain("Pending input");
  } finally {
    finishReply();
    finishTurn();
    await run;
  }
  await vi.waitFor(() => expect(lastFrame).toContain("Finished inspection."));
  expect(lastFrame).not.toContain("[Paste · 30 lines]");
  expect(lastFrame).not.toContain("rows folded");
  for (const row of [0, 15, 29]) {
    expect(lastFrame.match(new RegExp(`Original pasted log ${row}\\b`, "g"))).toHaveLength(1);
  }
  expect(useOutputStore.getState().history.find((turn) => turn.type === "user")?.content).toBe(
    prompt,
  );
  expect(useAnswerTranscriptStore.getState().entries.at(-1)?.prompt).toBe(prompt);
  expect(mounts.history).toBe(1);
});

it.each([
  "committed",
  "failed",
  "withdrawn",
])("acknowledges Enter before input preparation settles (%s), without prematurely retaining history", async (outcome) => {
  const store = useOutputStore.getState();
  const control = createInteractiveRunControl();
  const submission = createInteractiveSubmission({
    requestExit() {},
    requestRunAbort: control.segment.requestAbort,
  });
  const paste = Array.from({ length: 30 }, (_, i) => `Preparation paste row ${i}`).join("\n");
  const input = {
    document: [
      { type: "text" as const, text: "Inspect sentinel\n" },
      { type: "token" as const, kind: "paste" as const, text: paste },
    ],
    attachments: [],
  };
  let releasePreparation = () => {};
  const preparation = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  const originalCommit = userInputRepository.commitResolvedUserInput;
  const commit = vi
    .spyOn(userInputRepository, "commitResolvedUserInput")
    .mockImplementation(async (...args) => {
      await preparation;
      if (outcome !== "committed") {
        const error = new Error("Preparation failure sentinel");
        if (outcome === "withdrawn") error.name = "AbortError";
        throw error;
      }
      return originalCommit(...args);
    });
  let finishReply = () => {};
  const reply = new Promise<void>((resolve) => {
    finishReply = resolve;
  });
  const model: ModelAdapter = {
    id: "preparation-gated",
    async *stream(): AsyncGenerator<StreamEvent> {
      await reply;
      yield { type: "text", content: "Prepared answer sentinel." };
    },
  };
  let reads = 0;
  const restored = vi.fn((value: PromptInput) => {
    store.setPreparingInput(null);
    useComposerSession.getState().seedDraft(value);
  });
  mountDashboard();
  const run = runEvilJellyHost(
    {
      getInput: async () => (reads++ === 0 ? submission.getInput() : textPromptInput("/exit")),
      printOut: store.appendStream,
      logUserMessage: store.logUser,
      logAssistantMessage: store.logAssistant,
      logSystemEvent: store.logSystem,
      logToolBlock() {},
      onTranscriptTurn: store.updateTranscriptTurn,
      onTurnStart: store.beginTurn,
      onInputPreparationEnd: () => store.setPreparingInput(null),
      onPhaseUpdate: store.setPhase,
      restoreWithdrawnInput: restored,
      confirmTool: async () => ({ action: "accept" }),
      requestChoice: async ({ options }) => options[0]?.value ?? "",
    },
    { runControl: control, model, isolateSessionState: true },
  );
  try {
    await vi.waitFor(() => expect(reads).toBe(1));
    useComposerSession.getState().seedDraft(input);
    await vi.waitFor(() => expect(useComposerSession.getState().draftSeed).toBeNull());
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame).toContain("Pending input · preparing…");
      expect(lastFrame).toContain("❯ Inspect sentinel");
      expect(lastFrame).toContain("[Paste]");
      expect(commit).toHaveBeenCalledOnce();
    });
    expect(useOutputStore.getState().history).toHaveLength(0);
    expect(lastFrame).not.toContain("Preparation paste row");
    releasePreparation();
    if (outcome === "committed") {
      await vi.waitFor(() => expect(lastFrame).toContain("[Paste · 30 lines]"));
      expect(lastFrame).not.toContain("preparing…");
      expect(lastFrame).not.toContain("Preparation paste row");
      expect(useOutputStore.getState().pendingInput).not.toBeNull();
      finishReply();
    }
    await run;
    await vi.waitFor(() => expect(lastFrame).not.toContain("preparing…"));
    expect(useOutputStore.getState().preparingInput).toBeNull();
    const users = useOutputStore.getState().history.filter((turn) => turn.type === "user");
    if (outcome === "committed") {
      expect(users).toHaveLength(1);
      expect(users[0]?.content).toContain(paste);
      await vi.waitFor(() => expect(lastFrame).toContain("Prepared answer sentinel."));
      expect(lastFrame.match(/Preparation paste row 15\b/g)).toHaveLength(1);
    } else {
      expect(users).toHaveLength(0);
      expect(useOutputStore.getState().pendingInput).toBeNull();
      if (outcome === "withdrawn") expect(restored).toHaveBeenCalledWith(input);
      else expect(lastFrame).toContain("Preparation failure sentinel");
    }
  } finally {
    releasePreparation();
    finishReply();
    await run;
    commit.mockRestore();
  }
});

it("prepends withdrawn rich input while preserving live text and attachments", async () => {
  const submit = vi.fn();
  const composer = useComposerSession.getState();
  composer.setBackgroundLineHandler(submit);
  mountDashboard();
  await vi.waitFor(() => expect(lastFrame).toContain("Message"));
  const input = {
    document: [
      { type: "text" as const, text: "Restore " },
      { type: "token" as const, kind: "paste" as const, text: "one\ntwo\nthree\nfour\nfive\nsix" },
      { type: "token" as const, kind: "file" as const, attachmentId: "file" },
      { type: "token" as const, kind: "image" as const, attachmentId: "image" },
    ],
    attachments: [
      { id: "file", kind: "file" as const, path: "keep.ts" },
      {
        id: "image",
        kind: "image" as const,
        path: "keep.png",
        mimeType: "image/png" as const,
        ownership: "borrowed" as const,
      },
    ],
  };
  composer.seedDraft(input);
  await vi.waitFor(() => expect(lastFrame).toContain("@keep.ts[Image #1]"));
  expect(lastFrame).toContain("[Pasted text +6 lines]");
  stdin.write("\r");
  await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(input));
  await vi.waitFor(() => expect(lastFrame).toContain("Message"));

  stdin.write("Already typing");
  await vi.waitFor(() => expect(lastFrame).toContain("Already typing"));
  composer.seedDraft(input);
  await vi.waitFor(() => expect(lastFrame).toContain("@keep.ts[Image #1]"));
  expect(lastFrame).toContain("Already typing");
  stdin.write("\r");
  await vi.waitFor(() =>
    expect(submit).toHaveBeenLastCalledWith({
      document: [...input.document, { type: "text", text: "\nAlready typing" }],
      attachments: input.attachments,
    }),
  );
  await vi.waitFor(() => expect(lastFrame).toContain("Message"));

  // An attachment-only live draft must also survive prepending the withdrawn input.
  composer.seedDraft({
    document: [{ type: "token", kind: "file", attachmentId: "current-file" }],
    attachments: [{ id: "current-file", kind: "file", path: "new.ts" }],
  });
  await vi.waitFor(() => expect(lastFrame).toContain("@new.ts"));
  composer.seedDraft(input);
  await vi.waitFor(() => expect(lastFrame).toContain("@keep.ts[Image #1]"));
  expect(lastFrame).toContain("@new.ts");
  stdin.write("\r");
  await vi.waitFor(() =>
    expect(submit).toHaveBeenLastCalledWith({
      document: [
        ...input.document,
        { type: "text", text: "\n" },
        { type: "token", kind: "file", attachmentId: "current-file" },
      ],
      attachments: [...input.attachments, { id: "current-file", kind: "file", path: "new.ts" }],
    }),
  );
});

it("reads full questions and answers with independent paging, search, and copy", async () => {
  const copy = vi.mocked(copyTextToClipboard);
  copy.mockClear();
  const prompt = `Question heading\n${Array.from({ length: 30 }, (_, i) => `Trace needle ${i}`).join("\n")}`;
  const answer = `${Array.from({ length: 100 }, (_, i) => `## Answer row ${i}`).join("\n")}\n`;
  const store = useAnswerTranscriptStore.getState();
  store.updateTurn({
    turnId: "first",
    prompt,
    promptSummary: "Inspect logs\n[Paste · 30 lines] $mcp:docs",
    status: "completed",
    answer,
  });
  store.updateTurn({
    turnId: "second",
    prompt: "Another question",
    status: "completed",
    answer: "Different answer",
  });
  const press = async (key: string, visible: string) => {
    output = "";
    stdin.write(key);
    await vi.waitFor(() => expect(output).toContain(visible));
  };
  mountDashboard();
  await vi.waitFor(() => expect(output).toContain("Message"));
  await press("\u0014", "Different answer"); // Ctrl+T
  await press("\u001b[D", "## Answer row 0"); // Left: older turn
  expect(output).toContain("[Paste · 30 lines]");
  expect(output).not.toContain("Trace needle");
  expect(output).not.toContain("## Answer row 99");
  await press("\u001b[F", "## Answer row 99"); // End
  await press("p", "Trace needle 0");
  await press("\u001b[F", "Trace needle 29");
  await press("c", "Copied complete question.");
  expect(copy).toHaveBeenLastCalledWith(prompt);
  await press("p", "## Answer row 99");
  await press("p", "Trace needle 29");
  await press("\u001b", "Message"); // Esc
  await press("\u0014", "Trace needle 29");

  await press("/", "Type to search");
  await press("NEEDLE", "Search: NEEDLE"); // Match original paste, not its compact label.
  await press("\r", "/ search · Tab answer");
  expect(output).not.toContain("Different answer");
  await press("\r", "## Answer row 99");
  await press("c", "Copied complete answer.");
  expect(copy).toHaveBeenLastCalledWith(answer);
});

it("stretches the fresh composer divider to terminal width across resize and reader close", async () => {
  mountDashboard();
  const dividerWidth = () =>
    output
      .split("\n")
      .map((line) => line.trim())
      .reverse()
      .find((line) => /^─+$/.test(line))?.length;
  await vi.waitFor(() => expect(dividerWidth()).toBe(100));

  stdout.columns = 72;
  stdout.emit("resize");
  await vi.waitFor(() => expect(dividerWidth()).toBe(72));

  for (const shortcut of ["\u0014", "\u000f"]) {
    // Ctrl+T answers, Ctrl+O tools
    output = "";
    stdin.write(shortcut);
    const title = shortcut === "\u0014" ? "Transcript" : "Tool Calls";
    await vi.waitFor(() => expect(output).toContain(title));
    output = "";
    stdin.write("\u001b");
    await vi.waitFor(() => expect(dividerWidth()).toBe(72));
  }
  expect(mounts.history).toBe(1);
});

it("keeps tool list and detail chrome inside the viewport across width and height changes", async () => {
  useOutputStore.setState({
    toolHistory: Array.from({ length: 40 }, (_, index) => ({
      id: `tool-${index + 1}`,
      type: "tool" as const,
      content: "Read a long tool result",
      tool: {
        ordinal: index + 1,
        toolName: "read_file",
        summary: "Inspect a long tool result with 中文 and a very long path".repeat(3),
        preview: "Output row 0",
        fullResult: Array.from({ length: 60 }, (_, row) => `Output row ${row}`).join("\n"),
        ok: true,
      },
    })),
  });
  const sizes = [
    [100, 24],
    [48, 12],
    [24, 6],
    [32, 4],
    [100, 24],
  ] as const;
  const expectFrame = (title: string, footer: string) => {
    const lines = lastFrame.trimEnd().split("\n");
    expect(lines).toHaveLength(stdout.rows);
    expect(lines[0]).toContain(title);
    expect(lines.at(-1)).toContain(footer);
    expect(lines.every((line) => stringWidth(line) <= stdout.columns)).toBe(true);
  };

  mountDashboard();
  await vi.waitFor(() => expect(lastFrame).toContain("Message"));
  stdin.write("\u000f"); // Ctrl+O
  await vi.waitFor(() => expect(lastFrame).toContain("Tool Calls"));
  stdin.write("\u001b[F"); // End: keep the oldest selected tool visible during resize.
  await vi.waitFor(() => expect(lastFrame).toContain("40 of 40"));
  for (const [columns, rows] of sizes) {
    Object.assign(stdout, { columns, rows });
    stdout.emit("resize");
    await vi.waitFor(() => {
      expectFrame("Tool Calls", "40 of 40");
      expect(lastFrame).toContain("#1");
    });
  }

  stdin.write("\r"); // Detail uses the same height budget as the list.
  await vi.waitFor(() => expect(lastFrame).toContain("Tool Transcript"));
  for (const [columns, rows] of sizes) {
    Object.assign(stdout, { columns, rows });
    stdout.emit("resize");
    await vi.waitFor(() => expectFrame("Tool Transcript", "Line "));
    stdin.write("\u001b[F");
    await vi.waitFor(() => {
      expectFrame("Tool Transcript", "Line ");
      expect(lastFrame).toContain("Output row 59");
    });
  }
  stdin.write("\u001b"); // Back to the same selected list entry.
  await vi.waitFor(() => expectFrame("Tool Calls", "40 of 40"));
  stdin.write("\u001b");
  await vi.waitFor(() => expect(lastFrame).toContain("Message"));
  expect(mounts.history).toBe(1);
});

it("keeps the draft, attachments, and Static instance while reader keys own input", async () => {
  const submit = vi.fn();
  useComposerSession.getState().setBackgroundLineHandler(submit);
  useComposerSession.getState().seedDraft({
    document: [
      { type: "text", text: "keep draft " },
      { type: "token", kind: "file", attachmentId: "file-1" },
    ],
    attachments: [{ id: "file-1", kind: "file", path: "keep.ts" }],
  });
  useOutputStore.getState().logAssistant("History sentinel");
  useOutputStore.getState().setPhase("working");
  useAnswerTranscriptStore
    .getState()
    .updateTurn({ turnId: "t", prompt: "Question", answer: "## Answer", status: "completed" });
  mountDashboard();
  await vi.waitFor(() => expect(output).toContain("keep.ts"));
  stdin.write("\u0014"); // Ctrl+T
  await vi.waitFor(() => expect(output).toContain("Markdown source"));
  expect(useAnswerTranscriptStore.getState().open).toBe(true);
  output = "";
  stdin.write("x"); // Must not leak into the hidden composer.
  stdin.write("\u001b");
  await vi.waitFor(() => expect(useAnswerTranscriptStore.getState().open).toBe(false));
  await vi.waitFor(() => expect(output).toContain("keep draft @keep.ts"));
  expect(output).not.toContain("keep.tsx");
  expect(submit).not.toHaveBeenCalled();
  expect(mounts.history).toBe(1);

  stdin.write("\u0014");
  await vi.waitFor(() => expect(useAnswerTranscriptStore.getState().open).toBe(true));
  useDecisionStore.setState({
    decision: { type: "confirm", message: "Approve write?", defaultYes: false },
  });
  await vi.waitFor(() => expect(useAnswerTranscriptStore.getState().open).toBe(false));
  await vi.waitFor(() => expect(output).toContain("Approve write?"));
});
