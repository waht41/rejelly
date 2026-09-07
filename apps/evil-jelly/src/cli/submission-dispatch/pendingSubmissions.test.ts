import { beforeEach, describe, expect, it, vi } from "vitest";
import { textPromptInput } from "../../shared/model/prompt/promptInput";
import {
  addPendingSteer,
  ensurePendingCommand,
  getPendingSubmissions,
  removePendingSubmission,
  resetPendingSubmissions,
  subscribePendingSubmissions,
} from "./pendingSubmissions";

beforeEach(() => resetPendingSubmissions());

describe("pending submissions", () => {
  it("presents steers without owning their model-delivery payload", () => {
    const id = addPendingSteer(textPromptInput("check the tests"));

    expect(getPendingSubmissions()).toEqual([
      { id, kind: "steer", text: "check the tests", attachmentCount: 0 },
    ]);
  });

  it("coalesces repeated pending commands", () => {
    const first = ensurePendingCommand("/status");
    const second = ensurePendingCommand("/status");

    expect(first.added).toBe(true);
    expect(second).toEqual({ id: first.id, added: false });
    expect(getPendingSubmissions()).toEqual([{ id: first.id, kind: "command", text: "/status" }]);
  });

  it("notifies the pending area when an item is completed", () => {
    const subscriber = vi.fn();
    const unsubscribe = subscribePendingSubmissions(subscriber);
    const { id } = ensurePendingCommand("/status");

    removePendingSubmission(id);

    expect(subscriber).toHaveBeenLastCalledWith([]);
    unsubscribe();
  });
});
