import { create } from "zustand";
import type {
  ChoiceRequest,
  DecisionOption,
  DecisionSnapshot,
  DecisionView,
  ManagerDecisionAction,
  ManagerDecisionRequest,
} from "./model";

type PendingDecision =
  | { type: "idle" }
  | { type: "text"; resolve: (value: string) => void }
  | { type: "confirm"; resolve: (value: boolean) => void }
  | {
      type: "manager";
      kind: ManagerDecisionRequest["kind"];
      resolve: (value: ManagerDecisionAction) => void;
    }
  | {
      type: "choice";
      options: DecisionOption[];
      cancelValue?: string;
      resolve: (value: string) => void;
    };

const idleDecision: PendingDecision = { type: "idle" };

interface DecisionState {
  view: DecisionView;
  decision: DecisionSnapshot;
  pending: PendingDecision;
  requestText(label: string): Promise<string>;
  submitText(value: string): void;
  requestConfirm(message: string, initial?: boolean, view?: DecisionView): Promise<boolean>;
  submitConfirm(value: boolean): void;
  requestChoice(request: ChoiceRequest): Promise<string>;
  submitChoice(value: string): void;
  cancelChoice(): void;
  requestManager(request: ManagerDecisionRequest): Promise<ManagerDecisionAction>;
  submitManager(action: ManagerDecisionAction): void;
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
  requestChoice: ({ message, options, view, cancelValue }) =>
    new Promise((resolve) => {
      if (cancelValue !== undefined && !options.some((option) => option.value === cancelValue)) {
        throw new Error(`Choice cancelValue must match an option value: ${cancelValue}`);
      }
      set({
        ...(view !== undefined ? { view } : {}),
        decision: { type: "choice", message, options, cancelable: cancelValue !== undefined },
        pending: { type: "choice", options, cancelValue, resolve },
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
  cancelChoice: () => {
    const pending = get().pending;
    if (pending.type !== "choice" || pending.cancelValue === undefined) {
      return;
    }
    set(idleState());
    pending.resolve(pending.cancelValue);
  },
  requestManager: (manager) =>
    new Promise((resolve) => {
      set({
        view: { type: "none" },
        decision: { type: "manager", manager },
        pending: { type: "manager", kind: manager.kind, resolve },
      });
    }),
  submitManager: (result) => {
    const pending = get().pending;
    if (pending.type !== "manager" || pending.kind !== result.kind) return;
    if (result.action.action === "close") set(idleState());
    else set({ pending: idleDecision });
    pending.resolve(result);
  },
}));

export function resetDecisionStore(): void {
  useDecisionStore.setState(idleState());
}
