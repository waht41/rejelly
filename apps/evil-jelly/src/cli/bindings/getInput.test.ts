import { describe, expect, it } from "vitest";
import { resetOutputSession } from "../conversation-display/useOutputStore";
import {
  resetComposerSession,
  useComposerSession,
} from "../message-composer/session/composerSession";
import { registerRunAbort } from "../runtime/runControl";
import { takePendingExit } from "../runtime/sessionRunControl";
import { enqueueSteer } from "../runtime/steerControl";
import { createInkGetInput } from "./getInput";
import { resetLineInputQueue } from "./lineInputQueue";

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function resetCliStores(): void {
  resetLineInputQueue();
  resetComposerSession();
  resetOutputSession();
  takePendingExit();
}

describe("createInkGetInput", () => {
  it("passes idle exit input through to the main agent", async () => {
    resetCliStores();
    const getInput = createInkGetInput();

    const pending = getInput();
    useComposerSession.getState().submitLine({ text: "exit", attachments: [] });

    await expect(pending).resolves.toEqual({ text: "exit", attachments: [] });
    expect(takePendingExit()).toBe(false);
  });

  it("requests loop exit and aborts the run for background exit input", () => {
    resetCliStores();
    const reasons: string[] = [];
    const unregister = registerRunAbort((reason) => reasons.push(reason));
    createInkGetInput();

    useComposerSession.getState().submitLine({ text: "/exit" });

    unregister();
    expect(takePendingExit()).toBe(true);
    expect(reasons).toEqual(["Stopped by user (exit)"]);
  });

  it("queues background input as the next main input when it was not injected", async () => {
    resetCliStores();
    const getInput = createInkGetInput();

    useComposerSession.getState().submitLine({ text: "please steer this", attachments: [] });

    await expect(getInput()).resolves.toEqual({
      text: "please steer this",
      attachments: [],
    });
  });

  it("preserves background input order when multiple steers carry over", async () => {
    resetCliStores();
    const getInput = createInkGetInput();

    useComposerSession.getState().submitLine({ text: "first steer", attachments: [] });
    useComposerSession.getState().submitLine({ text: "second steer", attachments: [] });

    await expect(getInput()).resolves.toEqual({ text: "first steer", attachments: [] });
    await expect(getInput()).resolves.toEqual({ text: "second steer", attachments: [] });
  });

  it("restores queued steers to the prompt draft when stopping a running task", async () => {
    resetCliStores();
    const getInput = createInkGetInput();
    enqueueSteer({ text: "queued steer" });

    useComposerSession.getState().submitLine({ text: "/stop" });

    expect(useComposerSession.getState().draftSeed?.value).toEqual({
      text: "queued steer",
      attachments: [],
    });
    const pending = getInput();
    await flushMicrotasks();
    useComposerSession.getState().submitLine({ text: "manual next input", attachments: [] });
    await expect(pending).resolves.toEqual({ text: "manual next input", attachments: [] });
  });
});
