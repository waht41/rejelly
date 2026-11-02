import { afterEach, beforeEach, expect, it } from "vitest";
import { textPromptInput } from "../../shared/model/prompt/promptInput";
import { resetOutputSession, useOutputStore } from "../conversation-display/useOutputStore";
import { resetComposerSession } from "../message-composer/session/composerSession";
import { resetSubmissionDispatch } from "../submission-dispatch/dispatcher";
import { createInteractiveSubmission } from "./submission";

function reset() {
  resetSubmissionDispatch();
  resetOutputSession();
  resetComposerSession();
}
beforeEach(reset);
afterEach(reset);

it("acknowledges only main messages and keeps command, queued-steer, and cancellation lifecycles separate", async () => {
  const submission = createInteractiveSubmission({
    requestExit() {},
    requestRunAbort: () => false,
  });
  const state = () => useOutputStore.getState();
  const command = submission.getInput();
  submission.submit(textPromptInput("/status"));
  expect(state().preparingInput).toBeNull();
  await command;

  const main = submission.getInput();
  submission.submit(textPromptInput("First message"));
  // This update must be synchronous, not postponed until the runtime awaits getInput.
  expect(state().preparingInput).toEqual(textPromptInput("First message"));
  submission.submit(textPromptInput("Second message"));
  expect(state().preparingInput).toEqual(textPromptInput("First message"));
  await main;
  state().setPreparingInput(null); // The first message has committed.
  const next = await submission.getInput();
  expect(next).toEqual(textPromptInput("Second message"));
  expect(state().preparingInput).toEqual(next);
  state().setPreparingInput(null);
  submission.submit(textPromptInput("Queued steer"));
  expect(state().preparingInput).toBeNull();
  expect(await submission.getInput()).toEqual(textPromptInput("Queued steer"));
  expect(state().preparingInput).toEqual(textPromptInput("Queued steer"));
  submission.cancel("cancelled");
  expect(state().preparingInput).toBeNull();
  expect(state().history).toHaveLength(0);
});
