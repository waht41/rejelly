import { resetDecisionArbiter, runDecisionSession } from "./arbiter";
import { resetDecisionStore, useDecisionStore } from "./decisionStore";
import type { OperatorDecision, OperatorDecisionSession } from "./model";

const session: OperatorDecisionSession = {
  requestChoice: (request) => useDecisionStore.getState().requestChoice(request),
  requestMcpManager: (request) => useDecisionStore.getState().requestMcpManager(request),
  requestConfirm: (message, initial, view) =>
    useDecisionStore.getState().requestConfirm(message, initial, view),
  requestText: (label) => useDecisionStore.getState().requestText(label),
};

export function createOperatorDecision(): OperatorDecision {
  return {
    run: (operation) => runDecisionSession(() => operation(session)),
    requestChoice: (request) => runDecisionSession(() => session.requestChoice(request)),
    requestMcpManager: (request) => runDecisionSession(() => session.requestMcpManager(request)),
  };
}

export function resetOperatorDecisionSession(): void {
  resetDecisionArbiter();
  resetDecisionStore();
}
