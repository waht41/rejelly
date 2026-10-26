import { PassThrough } from "node:stream";
import type { ModelAdapter, StreamEvent } from "@rejelly/core";
import { render } from "ink";
import { createElement } from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EvilJellyBindings } from "../../shared/host/bindings";
import { textPromptInput } from "../../shared/model/prompt/promptInput";
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
import { createInteractiveRunControl } from "../unified-conversation/interactive/runControl";
import { runEvilJellyHost } from "../unified-conversation/interactive/runSegment";
import { copyTextToClipboard } from "./clipboard/clipboardText";
import { Dashboard } from "./Dashboard";

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
  store.logSystem("Interrupted active task.");
  await vi.waitFor(() => expect(lastFrame).toContain("Interrupted active task."));
  store.logSystem("Input withdrawn.");
  store.updateTranscriptTurn({ turnId: "withdrawn", status: "interrupted", withdrawn: true });
  await vi.waitFor(() => {
    expect(lastFrame).toContain("Input withdrawn.");
    expect(lastFrame.match(/Same question/g)).toHaveLength(1);
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
  await vi.waitFor(() => expect(lastFrame).toContain("Pending input row 99"));
  expect(lastFrame).not.toContain("Pending input row 0");
  expect(lastFrame.trimEnd().split("\n").length).toBeLessThanOrEqual(stdout.rows);
  store.logSystem("Input withdrawn.");
  store.updateTranscriptTurn({ turnId: "long", status: "interrupted", withdrawn: true });
  await vi.waitFor(() => expect(lastFrame).not.toContain("Pending input row"));
  expect(lastFrame).toContain("Message");
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
