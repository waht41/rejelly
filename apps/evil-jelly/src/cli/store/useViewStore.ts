/**
 * Transcript overlay state (ctrl+o) for viewing full tool results. UI-only; assistant output is
 * always rendered as markdown (with an automatic raw fallback in the stream when it can't render
 * safely — see streamWindow's forceRaw).
 */

import { create } from "zustand";

interface ViewState {
  /** Transcript overlay (ctrl+o) for full tool results. */
  transcriptOpen: boolean;
  openTranscript: () => void;
  closeTranscript: () => void;
}

export const useViewStore = create<ViewState>((set) => ({
  transcriptOpen: false,
  openTranscript: () => set({ transcriptOpen: true }),
  closeTranscript: () => set({ transcriptOpen: false }),
}));

/** Reset the transcript overlay for a fresh CLI session. */
export function resetViewSession(): void {
  useViewStore.setState({ transcriptOpen: false });
}
