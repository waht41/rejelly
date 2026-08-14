import { beforeEach, describe, expect, it } from "vitest";
import { useDecisionStore } from "./decisionStore";
import { createOperatorDecision, resetOperatorDecisionSession } from "./operatorDecision";

describe("operator decision", () => {
  beforeEach(() => resetOperatorDecisionSession());

  it("serializes complete decision sessions", async () => {
    const decision = createOperatorDecision();
    const first = decision.run((session) =>
      session.requestChoice({
        message: "First?",
        options: [{ key: "y", label: "Yes", value: "yes" }],
      }),
    );
    const second = decision.run((session) => session.requestText("Second: "));

    await Promise.resolve();
    expect(useDecisionStore.getState().decision).toMatchObject({
      type: "choice",
      message: "First?",
    });

    useDecisionStore.getState().submitChoice("yes");
    await expect(first).resolves.toBe("yes");
    await Promise.resolve();
    expect(useDecisionStore.getState().decision).toEqual({ type: "text", label: "Second: " });

    useDecisionStore.getState().submitText("feedback");
    await expect(second).resolves.toBe("feedback");
    expect(useDecisionStore.getState().decision).toEqual({ type: "idle" });
  });

  it("ignores values absent from the current choice", async () => {
    const pending = createOperatorDecision().requestChoice({
      message: "Pick",
      options: [{ key: "a", label: "Allowed", value: "allowed" }],
    });
    await Promise.resolve();

    useDecisionStore.getState().submitChoice("unknown");
    expect(useDecisionStore.getState().decision.type).toBe("choice");
    useDecisionStore.getState().submitChoice("allowed");

    await expect(pending).resolves.toBe("allowed");
  });

  it("resolves cancellation only through the explicit cancel value", async () => {
    const pending = createOperatorDecision().requestChoice({
      message: "Pick",
      options: [
        { key: "a", label: "Allowed", value: "allowed" },
        { key: "x", label: "Cancel", value: "cancelled" },
      ],
      cancelValue: "cancelled",
    });
    await Promise.resolve();

    expect(useDecisionStore.getState().decision).toMatchObject({
      type: "choice",
      cancelable: true,
    });
    useDecisionStore.getState().cancelChoice();

    await expect(pending).resolves.toBe("cancelled");
    expect(useDecisionStore.getState().decision).toEqual({ type: "idle" });
  });

  it("keeps a non-cancelable choice pending", async () => {
    const pending = createOperatorDecision().requestChoice({
      message: "Pick",
      options: [{ key: "a", label: "Allowed", value: "allowed" }],
    });
    await Promise.resolve();

    useDecisionStore.getState().cancelChoice();
    expect(useDecisionStore.getState().decision).toMatchObject({
      type: "choice",
      cancelable: false,
    });
    useDecisionStore.getState().submitChoice("allowed");
    await expect(pending).resolves.toBe("allowed");
  });

  it("rejects a cancel value absent from the options", async () => {
    await expect(
      createOperatorDecision().requestChoice({
        message: "Pick",
        options: [{ key: "a", label: "Allowed", value: "allowed" }],
        cancelValue: "missing",
      }),
    ).rejects.toThrow("Choice cancelValue must match an option value: missing");
  });
});
