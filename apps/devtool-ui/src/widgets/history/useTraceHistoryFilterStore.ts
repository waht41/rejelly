import type { TraceFilterRequest } from "@entities/trace/api";
import { create } from "zustand";

export type SavedTraceFilter = {
  id: string;
  name: string;
  request: TraceFilterRequest;
};

type TraceHistoryFilterState = {
  activeFilter: SavedTraceFilter | null;
  setActiveFilter: (filter: SavedTraceFilter | null) => void;
};

export const useTraceHistoryFilterStore = create<TraceHistoryFilterState>((set) => ({
  activeFilter: null,
  setActiveFilter: (filter) => set({ activeFilter: filter }),
}));
