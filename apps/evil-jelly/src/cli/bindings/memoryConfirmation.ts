import type { MemoryConfirmationHandler } from "../../shared/host/toolConfirmationBindings";
import { useOutputStore } from "../conversation-display/useOutputStore";
import { createOperatorDecision } from "../operator-decision/operatorDecision";

function memoryMutationPreview(request: Parameters<MemoryConfirmationHandler>[0]): string {
  const sections: string[] = [];
  if (request.before) {
    sections.push(`Before:\n${JSON.stringify(request.before, null, 2)}`);
  }
  if (request.after) {
    sections.push(`After:\n${JSON.stringify(request.after, null, 2)}`);
  }
  return sections.join("\n\n");
}

export function createInkRequestMemoryConfirmation(): MemoryConfirmationHandler {
  const decision = createOperatorDecision();
  return async (request) =>
    decision.run(async (session) => {
      useOutputStore
        .getState()
        .setPhase("awaiting_user", `memory ${request.operation} → ${request.id}`);
      const selected = await session.requestChoice({
        message:
          `Allow persistent memory ${request.operation} (${request.scope})?\n` +
          `ID: ${request.id}`,
        view: {
          type: "scrollable_text",
          text: memoryMutationPreview(request),
          caption: "Memory change preview",
        },
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
