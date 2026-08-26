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
export type ManagerRequest = McpManagerRequest;
export type ManagerAction = McpManagerAction;
export type MemoryManagerActionType = MemoryManagerAction;
export type MemoryManagerRequestType = MemoryManagerRequest;
export type SkillManagerActionType = SkillManagerAction;
export type SkillManagerRequestType = SkillManagerRequest;

export type DecisionSnapshot =
  | { type: "idle" }
  | { type: "text"; label: string }
  | { type: "confirm"; message: string; defaultYes: boolean }
  | { type: "choice"; message: string; options: DecisionOption[]; cancelable: boolean }
  | { type: "mcp_manager"; request: ManagerRequest }
  | { type: "memory_manager"; request: MemoryManagerRequestType }
  | { type: "skill_manager"; request: SkillManagerRequestType };

export interface OperatorDecisionSession {
  /** `cancelValue`, when supplied, must match an option and is resolved when the user presses Esc. */
  requestChoice(request: ChoiceRequest): Promise<string>;
  requestMcpManager(request: ManagerRequest): Promise<ManagerAction>;
  requestMemoryManager(request: MemoryManagerRequestType): Promise<MemoryManagerActionType>;
  requestSkillManager(request: SkillManagerRequestType): Promise<SkillManagerActionType>;
  requestConfirm(message: string, initial?: boolean, view?: DecisionView): Promise<boolean>;
  requestText(label: string): Promise<string>;
}

export interface OperatorDecision {
  run<T>(operation: (session: OperatorDecisionSession) => Promise<T>): Promise<T>;
  /** `cancelValue`, when supplied, must match an option and is resolved when the user presses Esc. */
  requestChoice(request: ChoiceRequest): Promise<string>;
  requestMcpManager(request: ManagerRequest): Promise<ManagerAction>;
  requestMemoryManager(request: MemoryManagerRequestType): Promise<MemoryManagerActionType>;
  requestSkillManager(request: SkillManagerRequestType): Promise<SkillManagerActionType>;
}
