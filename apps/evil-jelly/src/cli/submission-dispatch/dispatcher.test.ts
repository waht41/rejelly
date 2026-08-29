import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PromptInput, textPromptInput } from "../../shared/model/prompt/promptInput";
import {
  createSubmissionDispatcher,
  resetSubmissionDispatch,
  type SubmissionDispatchPorts,
} from "./dispatcher";
import { enqueueSteer } from "./steerQueue";

function createPorts() {
  const restored: PromptInput[] = [];
  const logs: string[] = [];
  const phases: string[] = [];
  const exits: string[] = [];
  const aborts: string[] = [];
  const ports: SubmissionDispatchPorts = {
    interruptTask: () => "interrupted",
    requestExit: () => exits.push("exit"),
    requestRunAbort: (reason) => {
      aborts.push(reason);
      return true;
    },
    restoreDraft: (draft) => restored.push(draft),
    logSystem: (message) => logs.push(message),
    setInputPhase: (phase) => phases.push(phase),
  };
  return { ports, restored, logs, phases, exits, aborts };
}

describe("submission dispatcher", () => {
  const roots: string[] = [];
  beforeEach(() => resetSubmissionDispatch());
  afterEach(async () => {
    resetSubmissionDispatch();
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("delivers an idle submission as the awaited main input", async () => {
    const { ports } = createPorts();
    const dispatcher = createSubmissionDispatcher(ports);
    const pending = dispatcher.getInput();

    dispatcher.submit(textPromptInput("hello"));

    await expect(pending).resolves.toEqual(textPromptInput("hello"));
  });

  it("buffers working submissions as ordered steers and carries them into main input", async () => {
    const { ports } = createPorts();
    const dispatcher = createSubmissionDispatcher(ports);
    dispatcher.submit(textPromptInput("first steer"));
    dispatcher.submit(textPromptInput("second steer"));

    await expect(dispatcher.getInput()).resolves.toEqual(textPromptInput("first steer"));
    await expect(dispatcher.getInput()).resolves.toEqual(textPromptInput("second steer"));
  });

  it("restores buffered steers and interrupts on stop", () => {
    const { ports, restored, logs } = createPorts();
    const dispatcher = createSubmissionDispatcher(ports);
    enqueueSteer(textPromptInput("queued steer"));

    dispatcher.submit(textPromptInput("/stop"));

    expect(restored).toEqual([textPromptInput("queued steer")]);
    expect(logs).toEqual(["interrupted"]);
  });

  it("requests run exit for a background exit submission", () => {
    const { ports, exits, aborts } = createPorts();
    const dispatcher = createSubmissionDispatcher(ports);

    dispatcher.submit(textPromptInput("/exit"));

    expect(exits).toEqual(["exit"]);
    expect(aborts).toEqual(["Stopped by user (exit)"]);
  });

  it("queues startup slash commands until the first main input request", async () => {
    const { ports, exits, aborts, logs } = createPorts();
    const dispatcher = createSubmissionDispatcher(ports, { initiallyAwaitingInput: true });

    dispatcher.submit(textPromptInput("/status"));

    expect(exits).toEqual([]);
    expect(aborts).toEqual([]);
    expect(logs).toEqual([]);
    await expect(dispatcher.getInput()).resolves.toEqual(textPromptInput("/status"));
  });

  it("does not route a rich document as a local command", async () => {
    const { ports, logs } = createPorts();
    const dispatcher = createSubmissionDispatcher(ports);
    const rich: PromptInput = {
      document: [
        { type: "text", text: "/stop " },
        { type: "token", kind: "paste", text: "payload" },
      ],
      attachments: [],
    };

    dispatcher.submit(rich);

    await expect(dispatcher.getInput()).resolves.toEqual(rich);
    expect(logs).toEqual([]);
  });

  it("cancels a pending input and restores queued steers", async () => {
    const { ports, restored } = createPorts();
    const dispatcher = createSubmissionDispatcher(ports);
    const pending = dispatcher.getInput();
    enqueueSteer(textPromptInput("queued steer"));

    expect(dispatcher.cancel("cancelled")).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "cancelled" });
    expect(restored).toEqual([textPromptInput("queued steer")]);
  });

  it("restores queued rich inputs without flattening paste or attachment tokens", () => {
    const { ports, restored } = createPorts();
    const dispatcher = createSubmissionDispatcher(ports);
    const rich: PromptInput = {
      document: [
        { type: "token", kind: "paste", text: "one\ntwo\nthree\nfour\nfive\nsix" },
        { type: "text", text: " " },
        { type: "token", kind: "file", attachmentId: "file-1" },
      ],
      attachments: [{ id: "file-1", kind: "file", path: "src/a.ts" }],
    };
    enqueueSteer(rich);

    dispatcher.submit(textPromptInput("/stop"));

    expect(restored).toEqual([rich]);
  });

  it("remaps colliding attachment ids when multiple rich steers become one draft", () => {
    const { ports, restored } = createPorts();
    const dispatcher = createSubmissionDispatcher(ports);
    const steer = (path: string): PromptInput => ({
      document: [{ type: "token", kind: "file", attachmentId: "file-1" }],
      attachments: [{ id: "file-1", kind: "file", path }],
    });
    enqueueSteer(steer("src/a.ts"));
    enqueueSteer(steer("src/b.ts"));

    dispatcher.submit(textPromptInput("/stop"));

    expect(restored[0]?.document).toEqual([
      { type: "token", kind: "file", attachmentId: "file-1" },
      { type: "text", text: "\n" },
      { type: "token", kind: "file", attachmentId: "file-1:1:1" },
    ]);
    expect(restored[0]?.attachments.map((attachment) => attachment.id)).toEqual([
      "file-1",
      "file-1:1:1",
    ]);
  });

  it("releases composer-owned images when an unconsumed queue is reset", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "evil-dispatch-cleanup-"));
    roots.push(root);
    const imagePath = path.join(root, "clipboard.png");
    await fs.writeFile(imagePath, "image");
    enqueueSteer({
      document: [{ type: "token", kind: "image", attachmentId: "image-1" }],
      attachments: [
        {
          id: "image-1",
          kind: "image",
          path: imagePath,
          mimeType: "image/png",
          ownership: "composer_temp",
        },
      ],
    });

    resetSubmissionDispatch();

    await vi.waitFor(async () => {
      await expect(fs.access(imagePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
