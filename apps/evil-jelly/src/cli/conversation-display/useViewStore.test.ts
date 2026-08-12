import { beforeEach, describe, expect, it } from "vitest";
import { resetViewSession, useViewStore } from "./useViewStore";

describe("useViewStore", () => {
  beforeEach(() => {
    resetViewSession();
  });

  it("transcript overlay is closed by default", () => {
    expect(useViewStore.getState().transcriptOpen).toBe(false);
  });

  it("open/close toggles the transcript overlay", () => {
    useViewStore.getState().openTranscript();
    expect(useViewStore.getState().transcriptOpen).toBe(true);
    useViewStore.getState().closeTranscript();
    expect(useViewStore.getState().transcriptOpen).toBe(false);
  });

  it("resetViewSession closes the transcript overlay", () => {
    useViewStore.getState().openTranscript();
    resetViewSession();
    expect(useViewStore.getState().transcriptOpen).toBe(false);
  });
});
