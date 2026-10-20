import { create } from "zustand";
import type { TranscriptItem, TranscriptTurnUpdate } from "../../../shared/session/transcript";
import type { AnswerAnchor } from "./layout";
import { type AnswerTranscriptEntry, buildAnswerTranscript } from "./projection";

interface AnswerTranscriptState {
  entries: AnswerTranscriptEntry[];
  open: boolean;
  selectedId: string | null;
  anchor: AnswerAnchor;
  questionAnchor: AnswerAnchor;
  detail: "answer" | "question";
  mode: "detail" | "list";
  query: string;
  openedEntryCount: number;
  updateTurn: (update: TranscriptTurnUpdate) => void;
  hydrate: (items: readonly TranscriptItem[]) => void;
  openTranscript: () => void;
  closeTranscript: () => void;
  select: (id: string) => void;
  setAnchor: (anchor: AnswerAnchor) => void;
  setQuestionAnchor: (anchor: AnswerAnchor) => void;
  setDetail: (detail: "answer" | "question") => void;
  setMode: (mode: "detail" | "list") => void;
  setQuery: (query: string) => void;
}

const initialView = {
  open: false,
  selectedId: null as string | null,
  anchor: { line: 0, offset: 0 },
  mode: "detail" as const,
  detail: "answer" as const,
  questionAnchor: { line: 0, offset: 0 },
  query: "",
  openedEntryCount: 0,
};

export const useAnswerTranscriptStore = create<AnswerTranscriptState>((set) => ({
  entries: [],
  ...initialView,
  updateTurn: (update) =>
    set((state) => {
      const previous = state.entries.find((entry) => entry.id === update.turnId);
      const entry: AnswerTranscriptEntry = {
        id: update.turnId,
        prompt: update.prompt ?? previous?.prompt ?? "Previous task",
        ...((update.promptSummary ?? previous?.promptSummary) === undefined
          ? {}
          : { promptSummary: update.promptSummary ?? previous?.promptSummary }),
        answer: update.answer ?? previous?.answer ?? "",
        status: update.status,
      };
      return {
        entries: previous
          ? state.entries.map((item) => (item.id === entry.id ? entry : item))
          : [...state.entries, entry],
      };
    }),
  hydrate: (items) => set({ entries: buildAnswerTranscript(items), ...initialView }),
  openTranscript: () =>
    set((state) => {
      const selected = state.entries.find((entry) => entry.id === state.selectedId);
      const latest = [...state.entries].reverse().find((entry) => entry.status !== "running");
      return {
        open: true,
        openedEntryCount: state.entries.length,
        selectedId: selected?.id ?? latest?.id ?? state.entries.at(-1)?.id ?? null,
      };
    }),
  closeTranscript: () => set({ open: false }),
  select: (id) =>
    set((state) =>
      state.selectedId === id
        ? {}
        : {
            selectedId: id,
            anchor: { line: 0, offset: 0 },
            questionAnchor: { line: 0, offset: 0 },
          },
    ),
  setAnchor: (anchor) => set({ anchor }),
  setQuestionAnchor: (questionAnchor) => set({ questionAnchor }),
  setDetail: (detail) => set({ detail }),
  setMode: (mode) => set({ mode }),
  setQuery: (query) => set({ query: query.slice(0, 512) }),
}));

/** /clear starts a new conversation; never leak answers or bookmarks into it. */
export function resetAnswerTranscriptSession(): void {
  useAnswerTranscriptStore.setState({ entries: [], ...initialView });
}
