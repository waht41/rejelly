import { beforeEach, describe, expect, it } from "vitest";
import { resetOutputSession } from "../conversation-display/useOutputStore";
import { useDecisionStore } from "../operator-decision/decisionStore";
import { resetOperatorDecisionSession } from "../operator-decision/operatorDecision";
import { createInkRequestMemoryConfirmation } from "./memoryConfirmation";

const entry = {
  id: "mem_00000000-0000-4000-8000-000000000001",
  scope: "project" as const,
  title: "PR description",
  summary: "Use the PR description as the squash commit message.",
  detail: "Keep the full Markdown content and pass it through a body file.",
  revision: 2,
};

describe("memory confirmation binding", () => {
  beforeEach(() => {
    resetOperatorDecisionSession();
    resetOutputSession();
  });

  it("keeps the choice message short and puts the full mutation in a scrollable view", async () => {
    const confirmation = createInkRequestMemoryConfirmation();
    const pending = confirmation({
      type: "memory_mutation",
      operation: "update",
      scope: "project",
      id: entry.id,
      expectedRevision: 2,
      before: entry,
      after: { ...entry, detail: `${entry.detail}\nPreserve headings and lists.`, revision: 3 },
      proposalSha256: "a".repeat(64),
      source: { source: "agent_tool" },
    });

    await Promise.resolve();

    expect(useDecisionStore.getState().decision).toMatchObject({
      type: "choice",
      message: `Allow persistent memory update (project)?\nID: ${entry.id}`,
    });
    expect(useDecisionStore.getState().view).toEqual({
      type: "scrollable_text",
      caption: "Memory change preview",
      text: expect.stringContaining("Before:\n"),
    });
    expect(useDecisionStore.getState().view).toEqual(
      expect.objectContaining({ text: expect.stringContaining("After:\n") }),
    );

    useDecisionStore.getState().submitChoice("reject");
    await expect(pending).resolves.toEqual({ action: "reject" });
  });
});
