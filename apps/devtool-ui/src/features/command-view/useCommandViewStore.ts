import { create } from "zustand";

interface CommandViewState {
  aiPanelOpen: boolean;
  setAIPanelOpen: (open: boolean) => void;
  openAIPanel: () => void;
  closeAIPanel: () => void;
  toggleAIPanel: () => void;
}

export const useCommandViewStore = create<CommandViewState>((set) => ({
  aiPanelOpen: false,
  setAIPanelOpen: (open) => set({ aiPanelOpen: open }),
  openAIPanel: () => set({ aiPanelOpen: true }),
  closeAIPanel: () => set({ aiPanelOpen: false }),
  toggleAIPanel: () => set((state) => ({ aiPanelOpen: !state.aiPanelOpen })),
}));
