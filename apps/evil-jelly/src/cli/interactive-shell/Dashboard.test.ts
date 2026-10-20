import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement } from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

beforeEach(() => {
  resetOutputSession();
  resetAnswerTranscriptSession();
  resetToolTranscriptViewSession();
  resetComposerSession();
  useDecisionStore.setState({ decision: { type: "idle" }, view: { type: "none" } });
  mounts.history = 0;
  output = "";
  stdin = new Input();
  stdout = Object.assign(new PassThrough(), { columns: 100, rows: 24, isTTY: true });
  stdout.on("data", (chunk) => {
    output += stripAnsi(String(chunk));
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

it("stretches the fresh composer divider to terminal width across resize and reader close", async () => {
  instance = render(createElement(Dashboard, { onCtrlCAbort: vi.fn() }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
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
  instance = render(createElement(Dashboard, { onCtrlCAbort: vi.fn() }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await vi.waitFor(() => expect(output).toContain("keep.ts"));
  stdin.write("\u0014"); // Ctrl+T
  await vi.waitFor(() => expect(output).toContain("Markdown source"));
  expect(useAnswerTranscriptStore.getState().open).toBe(true);
  stdin.write("p");
  await vi.waitFor(() => expect(useAnswerTranscriptStore.getState().detail).toBe("question"));
  await vi.waitFor(() => expect(output).toContain("original submitted input"));
  stdin.write("p");
  await vi.waitFor(() => expect(useAnswerTranscriptStore.getState().detail).toBe("answer"));
  stdin.write("/");
  await vi.waitFor(() => expect(output).toContain("Type to search"));
  stdin.write("Answer");
  await vi.waitFor(() => expect(useAnswerTranscriptStore.getState().query).toBe("Answer"));
  stdin.write("\r");
  await vi.waitFor(() => expect(output).toContain("/ search · Tab answer"));
  stdin.write("\r");
  await vi.waitFor(() => expect(useAnswerTranscriptStore.getState().mode).toBe("detail"));
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
