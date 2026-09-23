import type {
  McpManagerAction,
  McpManagerRequest,
  MemoryManagerAction,
  MemoryManagerRequest,
  PromptChoiceOption,
  PromptChoiceRequest,
  PromptChoiceView,
  SkillManagerAction,
  SkillManagerRequest,
} from "../../shared/host/inputBindings";

export type DecisionOption = PromptChoiceOption;
export type DecisionView = PromptChoiceView;
export type ChoiceRequest = PromptChoiceRequest;

/** Capability-specific payloads carried through the shared manager decision channel. */
export type ManagerDecisionRequest =
  | { kind: "mcp"; request: McpManagerRequest }
  | { kind: "memory"; request: MemoryManagerRequest }
  | { kind: "skill"; request: SkillManagerRequest };

export type ManagerDecisionAction =
  | { kind: "mcp"; action: McpManagerAction }
  | { kind: "memory"; action: MemoryManagerAction }
  | { kind: "skill"; action: SkillManagerAction };

export type ManagerDecisionKind = ManagerDecisionRequest["kind"];
export type ManagerRequestFor<K extends ManagerDecisionKind> = Extract<
  ManagerDecisionRequest,
  { kind: K }
>["request"];
export type ManagerActionFor<K extends ManagerDecisionKind> = Extract<
  ManagerDecisionAction,
  { kind: K }
>["action"];

export type DecisionSnapshot =
  | { type: "idle" }
  | { type: "text"; label: string }
  | { type: "confirm"; message: string; defaultYes: boolean }
  | { type: "choice"; message: string; options: DecisionOption[]; cancelable: boolean }
  | { type: "manager"; manager: ManagerDecisionRequest };

export interface OperatorDecisionSession {
  /** `cancelValue`, when supplied, must match an option and is resolved when the user presses Esc. */
  requestChoice(request: ChoiceRequest): Promise<string>;
  requestManager(request: ManagerDecisionRequest): Promise<ManagerDecisionAction>;
  requestConfirm(message: string, initial?: boolean, view?: DecisionView): Promise<boolean>;
  requestText(label: string): Promise<string>;
}

export interface OperatorDecision {
  run<T>(operation: (session: OperatorDecisionSession) => Promise<T>): Promise<T>;
  /** `cancelValue`, when supplied, must match an option and is resolved when the user presses Esc. */
  requestChoice(request: ChoiceRequest): Promise<string>;
  requestManager(request: ManagerDecisionRequest): Promise<ManagerDecisionAction>;
}
