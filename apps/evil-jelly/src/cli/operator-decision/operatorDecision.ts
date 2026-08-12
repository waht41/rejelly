import { resetDecisionArbiter, runDecisionSession } from "./arbiter";
import { resetDecisionStore, useDecisionStore } from "./decisionStore";
import type { OperatorDecision, OperatorDecisionSession } from "./model";

const session: OperatorDecisionSession = {
  requestChoice: (message, options, view) =>
    useDecisionStore.getState().requestChoice(message, options, view),
  requestConfirm: (message, initial, view) =>
    useDecisionStore.getState().requestConfirm(message, initial, view),
  requestText: (label) => useDecisionStore.getState().requestText(label),
};

export function createOperatorDecision(): OperatorDecision {
  return {
    run: (operation) => runDecisionSession(() => operation(session)),
    requestChoice: (message, options, view) =>
      runDecisionSession(() => session.requestChoice(message, options, view)),
  };
}

export function resetOperatorDecisionSession(): void {
  resetDecisionArbiter();
  resetDecisionStore();
}
