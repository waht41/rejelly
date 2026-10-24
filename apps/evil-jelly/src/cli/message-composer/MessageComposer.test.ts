import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement } from "react";
import stripAnsi from "strip-ansi";
import { afterEach, expect, it, vi } from "vitest";
import { textPromptDocument } from "../../shared/model/prompt/promptDocument";
import { MessageComposer } from "./MessageComposer";
import { resetComposerSession, useComposerSession } from "./session/composerSession";

const { setCursorPosition } = vi.hoisted(() => ({ setCursorPosition: vi.fn() }));
vi.mock("ink", async (original) => ({
  ...(await original<typeof import("ink")>()),
  useCursor: () => ({ setCursorPosition }),
}));

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
const stdin = new Input();
const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true });
const stderr = new PassThrough();

afterEach(() => {
  instance?.unmount();
  stdin.destroy();
  stdout.destroy();
  stderr.destroy();
  resetComposerSession();
});

it("aligns the caret with pasted tabs and preserves them through collapse, editing, and expansion", async () => {
  const submit = vi.fn();
  resetComposerSession();
  useComposerSession.getState().setBackgroundLineHandler(submit);
  let output = "";
  stdout.on("data", (chunk) => {
    output += stripAnsi(String(chunk));
  });
  instance = render(
    createElement(MessageComposer, {
      label: "❯",
      isAgentRunning: false,
      hasInterruptibleTask: () => false,
      onInterrupt: vi.fn(),
      onCycleMode: vi.fn(),
      onCommand: () => false,
      onNotice: vi.fn(),
      readClipboardImage: async () => ({ ok: false as const, message: "No image" }),
    }),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  const caretAt = async (x: number, y = 0) => {
    await vi.waitFor(() => expect(setCursorPosition).toHaveBeenLastCalledWith({ x, y }));
  };
  const paste = (text: string) => stdin.write(`\u001b[200~${text}\u001b[201~`);
  const pasted = "\tfirst\n\tsecond\nthird\nfourth\nfifth\nsixth";

  await caretAt(2);
  paste(pasted);
  await caretAt(24); // Label + [Pasted text +6 lines].
  expect(output).toContain("[Pasted text +6 lines]");
  await new Promise((resolve) => setTimeout(resolve, 150)); // Outside the paste-chunk merge window.
  output = "";
  paste(" 中文\tmux");
  await caretAt(34);
  expect(output).toContain("[Pasted text +6 lines] 中文  mux");
  expect(output).not.toContain("\t");
  for (const x of [33, 32, 31, 29]) {
    stdin.write("\u001b[D");
    await caretAt(x);
  }
  stdin.write("!");
  await caretAt(30);
  stdin.write("\r");
  await vi.waitFor(() =>
    expect(submit).toHaveBeenCalledWith({
      document: [
        { type: "token", kind: "paste", text: pasted },
        { type: "text", text: " 中文!\tmux" },
      ],
      attachments: [],
    }),
  );

  await caretAt(2);
  paste(pasted);
  await caretAt(24);
  await new Promise((resolve) => setTimeout(resolve, 150));
  output = "";
  paste(pasted); // Repeating the same paste expands the existing token.
  await caretAt(7, 5);
  expect(output).toContain("❯   first");
  expect(output).not.toContain("\t");
  stdin.write("\r");
  await vi.waitFor(() =>
    expect(submit).toHaveBeenLastCalledWith({
      document: textPromptDocument(pasted),
      attachments: [],
    }),
  );
});
