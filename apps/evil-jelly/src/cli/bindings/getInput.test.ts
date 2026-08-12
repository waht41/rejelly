import { describe, expect, it } from "vitest";
import { registerRunAbort } from "../runtime/runControl";
import { takePendingExit } from "../runtime/sessionRunControl";
import { enqueueSteer } from "../runtime/steerControl";
import { resetOutputSession } from "../store/useOutputStore";
import { resetPromptSession, usePromptStore } from "../store/usePromptStore";
import { createInkGetInput } from "./getInput";
import { resetPromptQueue } from "./promptQueue";

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function resetCliStores(): void {
  resetPromptQueue();
  resetPromptSession();
  resetOutputSession();
  takePendingExit();
}

describe("createInkGetInput", () => {
  it("passes idle exit input through to the main agent", async () => {
    resetCliStores();
    const getInput = createInkGetInput();

    const pending = getInput();
    usePromptStore.getState().submitLine("exit");

    await expect(pending).resolves.toEqual({ text: "exit", attachments: [] });
    expect(takePendingExit()).toBe(false);
  });

  it("requests loop exit and aborts the run for background exit input", () => {
    resetCliStores();
    const reasons: string[] = [];
    const unregister = registerRunAbort((reason) => reasons.push(reason));
    createInkGetInput();

    usePromptStore.getState().submitLine("/exit");

    unregister();
    expect(takePendingExit()).toBe(true);
    expect(reasons).toEqual(["Stopped by user (exit)"]);
  });

  it("queues background input as the next main input when it was not injected", async () => {
    resetCliStores();
    const getInput = createInkGetInput();

    usePromptStore.getState().submitLine("please steer this");

    await expect(getInput()).resolves.toEqual({
      text: "please steer this",
      attachments: [],
    });
  });

  it("preserves background input order when multiple steers carry over", async () => {
    resetCliStores();
    const getInput = createInkGetInput();

    usePromptStore.getState().submitLine("first steer");
    usePromptStore.getState().submitLine("second steer");

    await expect(getInput()).resolves.toEqual({ text: "first steer", attachments: [] });
    await expect(getInput()).resolves.toEqual({ text: "second steer", attachments: [] });
  });

  it("restores queued steers to the prompt draft when stopping a running task", async () => {
    resetCliStores();
    const getInput = createInkGetInput();
    enqueueSteer({ text: "queued steer" });

    usePromptStore.getState().submitLine("/stop");

    expect(usePromptStore.getState().draftSeed?.value).toEqual({
      text: "queued steer",
      attachments: [],
    });
    const pending = getInput();
    await flushMicrotasks();
    usePromptStore.getState().submitLine("manual next input");
    await expect(pending).resolves.toEqual({ text: "manual next input", attachments: [] });
  });
});
