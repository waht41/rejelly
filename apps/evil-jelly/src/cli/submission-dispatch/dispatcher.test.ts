import { beforeEach, describe, expect, it } from "vitest";
import type { LineInputValue } from "../../shared/host/inputBindings";
import {
  createSubmissionDispatcher,
  resetSubmissionDispatch,
  type SubmissionDispatchPorts,
} from "./dispatcher";
import { enqueueSteer } from "./steerQueue";

function createPorts() {
  const restored: LineInputValue[] = [];
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
  beforeEach(() => resetSubmissionDispatch());

  it("delivers an idle submission as the awaited main input", async () => {
    const { ports } = createPorts();
    const dispatcher = createSubmissionDispatcher(ports);
    const pending = dispatcher.getInput();

    dispatcher.submit({ text: "hello", attachments: [] });

    await expect(pending).resolves.toEqual({ text: "hello", attachments: [] });
  });

  it("buffers working submissions as ordered steers and carries them into main input", async () => {
    const { ports } = createPorts();
    const dispatcher = createSubmissionDispatcher(ports);
    dispatcher.submit({ text: "first steer", attachments: [] });
    dispatcher.submit({ text: "second steer", attachments: [] });

    await expect(dispatcher.getInput()).resolves.toEqual({
      text: "first steer",
      attachments: [],
    });
    await expect(dispatcher.getInput()).resolves.toEqual({
      text: "second steer",
      attachments: [],
    });
  });

  it("restores buffered steers and interrupts on stop", () => {
    const { ports, restored, logs } = createPorts();
    const dispatcher = createSubmissionDispatcher(ports);
    enqueueSteer({ text: "queued steer" });

    dispatcher.submit({ text: "/stop" });

    expect(restored).toEqual([{ text: "queued steer", attachments: [] }]);
    expect(logs).toEqual(["interrupted"]);
  });

  it("requests run exit for a background exit submission", () => {
    const { ports, exits, aborts } = createPorts();
    const dispatcher = createSubmissionDispatcher(ports);

    dispatcher.submit({ text: "/exit" });

    expect(exits).toEqual(["exit"]);
    expect(aborts).toEqual(["Stopped by user (exit)"]);
  });

  it("cancels a pending input and restores queued steers", async () => {
    const { ports, restored } = createPorts();
    const dispatcher = createSubmissionDispatcher(ports);
    const pending = dispatcher.getInput();
    enqueueSteer({ text: "queued steer" });

    expect(dispatcher.cancel("cancelled")).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "cancelled" });
    expect(restored).toEqual([{ text: "queued steer", attachments: [] }]);
  });
});
