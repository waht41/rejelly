import { beforeEach, describe, expect, it } from "vitest";
import { resetToolTranscriptViewSession, useToolTranscriptViewStore } from "./viewStore";

describe("useToolTranscriptViewStore", () => {
  beforeEach(() => {
    resetToolTranscriptViewSession();
  });

  it("transcript overlay is closed by default", () => {
    expect(useToolTranscriptViewStore.getState().transcriptOpen).toBe(false);
  });

  it("open/close toggles the transcript overlay", () => {
    useToolTranscriptViewStore.getState().openTranscript();
    expect(useToolTranscriptViewStore.getState().transcriptOpen).toBe(true);
    useToolTranscriptViewStore.getState().closeTranscript();
    expect(useToolTranscriptViewStore.getState().transcriptOpen).toBe(false);
  });

  it("resetToolTranscriptViewSession closes the transcript overlay", () => {
    useToolTranscriptViewStore.getState().openTranscript();
    resetToolTranscriptViewSession();
    expect(useToolTranscriptViewStore.getState().transcriptOpen).toBe(false);
  });
});
