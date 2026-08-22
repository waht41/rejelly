import type { MemoryConfirmationHandler } from "../../shared/host/toolConfirmationBindings";
import { useOutputStore } from "../conversation-display/useOutputStore";
import { createOperatorDecision } from "../operator-decision/operatorDecision";

export function createInkRequestMemoryConfirmation(): MemoryConfirmationHandler {
  const decision = createOperatorDecision();
  return async (request) =>
    decision.run(async (session) => {
      useOutputStore
        .getState()
        .setPhase("awaiting_user", `memory ${request.operation} → ${request.id}`);
      const before = request.before ? `\nBefore:\n${JSON.stringify(request.before, null, 2)}` : "";
      const after = request.after ? `\nAfter:\n${JSON.stringify(request.after, null, 2)}` : "";
      const selected = await session.requestChoice({
        message:
          `Allow persistent memory ${request.operation} (${request.scope})?\n` +
          `ID: ${request.id}${before}${after}`,
        options: [
          { key: "y", label: "Accept memory change", value: "accept" },
          { key: "n", label: "Reject", value: "reject" },
        ],
        cancelValue: "reject",
      });
      useOutputStore.getState().resumeWork("Running…");
      return selected === "accept" ? { action: "accept" } : { action: "reject" };
    });
}
