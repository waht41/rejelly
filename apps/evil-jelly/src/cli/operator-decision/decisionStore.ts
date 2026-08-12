import { create } from "zustand";
import type { DecisionOption, DecisionSnapshot, DecisionView } from "./model";

type PendingDecision =
  | { type: "idle" }
  | { type: "text"; resolve: (value: string) => void }
  | { type: "confirm"; resolve: (value: boolean) => void }
  | { type: "choice"; options: DecisionOption[]; resolve: (value: string) => void };

const idleDecision: PendingDecision = { type: "idle" };

interface DecisionState {
  view: DecisionView;
  decision: DecisionSnapshot;
  pending: PendingDecision;
  requestText(label: string): Promise<string>;
  submitText(value: string): void;
  requestConfirm(message: string, initial?: boolean, view?: DecisionView): Promise<boolean>;
  submitConfirm(value: boolean): void;
  requestChoice(message: string, options: DecisionOption[], view?: DecisionView): Promise<string>;
  submitChoice(value: string): void;
}

function idleState(): Pick<DecisionState, "view" | "decision" | "pending"> {
  return { view: { type: "none" }, decision: { type: "idle" }, pending: idleDecision };
}

export const useDecisionStore = create<DecisionState>((set, get) => ({
  ...idleState(),
  requestText: (label) =>
    new Promise((resolve) => {
      set({
        view: { type: "none" },
        decision: { type: "text", label },
        pending: { type: "text", resolve },
      });
    }),
  submitText: (value) => {
    const pending = get().pending;
    if (pending.type !== "text") return;
    set(idleState());
    pending.resolve(value);
  },
  requestConfirm: (message, initial = true, view) =>
    new Promise((resolve) => {
      set({
        ...(view !== undefined ? { view } : {}),
        decision: { type: "confirm", message, defaultYes: initial },
        pending: { type: "confirm", resolve },
      });
    }),
  submitConfirm: (value) => {
    const pending = get().pending;
    if (pending.type !== "confirm") return;
    set(idleState());
    pending.resolve(value);
  },
  requestChoice: (message, options, view) =>
    new Promise((resolve) => {
      set({
        ...(view !== undefined ? { view } : {}),
        decision: { type: "choice", message, options },
        pending: { type: "choice", options, resolve },
      });
    }),
  submitChoice: (value) => {
    const pending = get().pending;
    if (pending.type !== "choice" || !pending.options.some((option) => option.value === value)) {
      return;
    }
    set(idleState());
    pending.resolve(value);
  },
}));

export function resetDecisionStore(): void {
  useDecisionStore.setState(idleState());
}
