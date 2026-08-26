import { create } from "zustand";
import type {
  ChoiceRequest,
  DecisionOption,
  DecisionSnapshot,
  DecisionView,
  ManagerAction,
  ManagerRequest,
  MemoryManagerActionType,
  MemoryManagerRequestType,
  SkillManagerActionType,
  SkillManagerRequestType,
} from "./model";

type PendingDecision =
  | { type: "idle" }
  | { type: "text"; resolve: (value: string) => void }
  | { type: "confirm"; resolve: (value: boolean) => void }
  | { type: "mcp_manager"; resolve: (value: ManagerAction) => void }
  | { type: "memory_manager"; resolve: (value: MemoryManagerActionType) => void }
  | { type: "skill_manager"; resolve: (value: SkillManagerActionType) => void }
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
  requestMcpManager(request: ManagerRequest): Promise<ManagerAction>;
  submitMcpManager(action: ManagerAction): void;
  requestMemoryManager(request: MemoryManagerRequestType): Promise<MemoryManagerActionType>;
  submitMemoryManager(action: MemoryManagerActionType): void;
  requestSkillManager(request: SkillManagerRequestType): Promise<SkillManagerActionType>;
  submitSkillManager(action: SkillManagerActionType): void;
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
  requestMcpManager: (request) =>
    new Promise((resolve) => {
      set({
        view: { type: "none" },
        decision: { type: "mcp_manager", request },
        pending: { type: "mcp_manager", resolve },
      });
    }),
  submitMcpManager: (action) => {
    const pending = get().pending;
    if (pending.type !== "mcp_manager") return;
    if (action.action === "close") set(idleState());
    else set({ pending: idleDecision });
    pending.resolve(action);
  },
  requestMemoryManager: (request) =>
    new Promise((resolve) => {
      set({
        view: { type: "none" },
        decision: { type: "memory_manager", request },
        pending: { type: "memory_manager", resolve },
      });
    }),
  submitMemoryManager: (action) => {
    const pending = get().pending;
    if (pending.type !== "memory_manager") return;
    if (action.action === "close") set(idleState());
    else set({ pending: idleDecision });
    pending.resolve(action);
  },
  requestSkillManager: (request) =>
    new Promise((resolve) => {
      set({
        view: { type: "none" },
        decision: { type: "skill_manager", request },
        pending: { type: "skill_manager", resolve },
      });
    }),
  submitSkillManager: (action) => {
    const pending = get().pending;
    if (pending.type !== "skill_manager") return;
    if (action.action === "close") set(idleState());
    else set({ pending: idleDecision });
    pending.resolve(action);
  },
}));

export function resetDecisionStore(): void {
  useDecisionStore.setState(idleState());
}
