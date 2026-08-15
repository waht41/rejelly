import { describe, expect, it, vi } from "vitest";
import { textPromptInput } from "../../shared/model/prompt/promptInput";
import { dispatchSelectedCommand } from "./useComposerDraft";

describe("selected composer commands", () => {
  it("submits router commands such as /exit", () => {
    const submitLine = vi.fn();

    expect(dispatchSelectedCommand(" /exit ", () => false, submitLine)).toBe("submitted");
    expect(submitLine).toHaveBeenCalledWith(textPromptInput("/exit"));
  });

  it("does not submit commands handled locally by the composer host", () => {
    const submitLine = vi.fn();

    expect(dispatchSelectedCommand("/copy-last", () => true, submitLine)).toBe("handled");
    expect(submitLine).not.toHaveBeenCalled();
  });
});
