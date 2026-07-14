import { beforeEach, describe, expect, it } from "vitest";
import { applyModeCommand, MODE_ORDER, resetModeSession, useModeStore } from "./useModeStore";

describe("useModeStore", () => {
  beforeEach(() => {
    resetModeSession();
  });

  it("defaults to the safe 'normal' mode", () => {
    expect(useModeStore.getState().mode).toBe("normal");
  });

  it("cycleMode advances through MODE_ORDER and wraps", () => {
    const seen: string[] = [];
    for (let i = 0; i < MODE_ORDER.length + 1; i++) {
      seen.push(useModeStore.getState().cycleMode());
    }
    // normal -> auto -> normal (wraps), and the returned value matches the new state.
    expect(seen).toEqual(["auto", "normal", "auto"]);
    expect(useModeStore.getState().mode).toBe("auto");
  });

  it("resetModeSession returns to normal", () => {
    useModeStore.getState().setMode("auto");
    resetModeSession();
    expect(useModeStore.getState().mode).toBe("normal");
  });

  describe("applyModeCommand", () => {
    it("returns null for non-mode input (falls through to normal send)", () => {
      expect(applyModeCommand("hello world")).toBeNull();
      expect(applyModeCommand("/modes")).toBeNull();
      expect(useModeStore.getState().mode).toBe("normal");
    });

    it("/mode cycles", () => {
      expect(applyModeCommand("/mode")).toBe("auto");
      expect(useModeStore.getState().mode).toBe("auto");
      expect(applyModeCommand("  /mode  ")).toBe("normal");
    });

    it("/mode auto and /mode normal set explicitly (idempotent)", () => {
      expect(applyModeCommand("/mode auto")).toBe("auto");
      expect(applyModeCommand("/mode auto")).toBe("auto");
      expect(useModeStore.getState().mode).toBe("auto");
      expect(applyModeCommand("/mode normal")).toBe("normal");
      expect(useModeStore.getState().mode).toBe("normal");
    });

    it("ignores an unknown arg by cycling", () => {
      expect(applyModeCommand("/mode wat")).toBe("auto");
    });
  });
});
