/**
 * Trace store (Zustand) – pure client state only.
 *
 * - Holds: currentTraceId, normalizedTrace, status.
 * - No async/IO here: no fetch, no adapter.connect, no storage read.
 * - All trace summaries (including imported files) live on the server, fetched
 *   via React Query (useTraceList / useTraceSummary).
 * - Connection lifecycle lives in useTraceConnection; list fetch in useTraceList.
 */

import { create } from "zustand";
import type { TraceActions, TraceState } from "./types";

export const useTraceStore = create<TraceState & TraceActions>()((set) => ({
  currentTraceId: null,
  normalizedTrace: null,
  status: "idle",
  error: null,
  reloadTrigger: 0,

  setCurrentTraceId: (id) => set({ currentTraceId: id }),
  setNormalizedTraceData: (data) => set({ normalizedTrace: data }),
  setStatus: (status) => set({ status }),

  closeTrace: () =>
    set({
      currentTraceId: null,
      normalizedTrace: null,
      status: "idle",
      error: null,
    }),
  reload: () => set((s) => ({ reloadTrigger: s.reloadTrigger + 1 })),
}));

export type { TraceSummary } from "./types";
