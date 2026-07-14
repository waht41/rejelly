import { create } from "zustand";

interface ViewSwitcherState {
  showTraceHistory: boolean;
  toggleTraceHistory: () => void;
  setShowTraceHistory: (open: boolean) => void;
}

export const useViewSwitcherStore = create<ViewSwitcherState>((set) => ({
  showTraceHistory: false,
  toggleTraceHistory: () => set((s) => ({ showTraceHistory: !s.showTraceHistory })),
  setShowTraceHistory: (open) => set({ showTraceHistory: open }),
}));
