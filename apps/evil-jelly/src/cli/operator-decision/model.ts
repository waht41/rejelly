import type {
  PromptChoiceOption,
  PromptChoiceRequest,
  PromptChoiceView,
} from "../../shared/host/inputBindings";

export type DecisionOption = PromptChoiceOption;
export type DecisionView = PromptChoiceView;
export type ChoiceRequest = PromptChoiceRequest;

export type DecisionSnapshot =
  | { type: "idle" }
  | { type: "text"; label: string }
  | { type: "confirm"; message: string; defaultYes: boolean }
  | { type: "choice"; message: string; options: DecisionOption[]; cancelable: boolean };

export interface OperatorDecisionSession {
  /** `cancelValue`, when supplied, must match an option and is resolved when the user presses Esc. */
  requestChoice(request: ChoiceRequest): Promise<string>;
  requestConfirm(message: string, initial?: boolean, view?: DecisionView): Promise<boolean>;
  requestText(label: string): Promise<string>;
}

export interface OperatorDecision {
  run<T>(operation: (session: OperatorDecisionSession) => Promise<T>): Promise<T>;
  /** `cancelValue`, when supplied, must match an option and is resolved when the user presses Esc. */
  requestChoice(request: ChoiceRequest): Promise<string>;
}
