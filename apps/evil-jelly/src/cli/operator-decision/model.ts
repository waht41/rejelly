export type DecisionOption = { key: string; label: string; value: string };

export type DecisionView =
  | { type: "none" }
  | { type: "diff"; text: string; caption?: string; captionTitle?: string }
  | { type: "markdown"; text: string };

export type DecisionSnapshot =
  | { type: "idle" }
  | { type: "text"; label: string }
  | { type: "confirm"; message: string; defaultYes: boolean }
  | { type: "choice"; message: string; options: DecisionOption[] };

export interface OperatorDecisionSession {
  requestChoice(message: string, options: DecisionOption[], view?: DecisionView): Promise<string>;
  requestConfirm(message: string, initial?: boolean, view?: DecisionView): Promise<boolean>;
  requestText(label: string): Promise<string>;
}

export interface OperatorDecision {
  run<T>(operation: (session: OperatorDecisionSession) => Promise<T>): Promise<T>;
  requestChoice(message: string, options: DecisionOption[], view?: DecisionView): Promise<string>;
}
