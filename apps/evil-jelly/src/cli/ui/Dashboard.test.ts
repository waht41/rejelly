import { renderToString } from "ink";
import { createElement } from "react";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimePhase } from "../../shared/conversation/viewBindings";
import { resetOutputSession, useOutputStore } from "../store/useOutputStore";
import { RuntimeStatusLine } from "./Dashboard";

beforeEach(() => {
  resetOutputSession();
});

afterEach(() => {
  resetOutputSession();
});

/** Place the runtime at a known point in a turn; ages are seconds before now. */
function setRuntime(runtime: {
  phase: RuntimePhase;
  detail?: string;
  turnAgeSeconds?: number | null;
  phaseAgeSeconds?: number;
}): void {
  const now = Date.now();
  const { phase, detail, turnAgeSeconds = null, phaseAgeSeconds = 0 } = runtime;
  useOutputStore.setState((state) => ({
    runtime: {
      ...state.runtime,
      phase,
      phaseSince: now - phaseAgeSeconds * 1_000,
      turnStartedAt: turnAgeSeconds === null ? null : now - turnAgeSeconds * 1_000,
      ...(detail === undefined ? {} : { detail }),
    },
  }));
}

function statusLine(columns = 100): string {
  return stripAnsi(renderToString(createElement(RuntimeStatusLine), { columns })).trimEnd();
}

/** The seconds the line is displaying, or null when it shows no number. */
function displayedSeconds(line: string): number | null {
  const match = /\b(\d+)s\b/.exec(line);
  return match ? Number(match[1]) : null;
}

describe("RuntimeStatusLine", () => {
  it("stays within the terminal on a long detail", () => {
    // This line lives in the dynamic frame, where Ink erases by the row count it computed. A row
    // wider than the terminal is soft-wrapped into a second physical row Ink never counted, and
    // the leftover survives as a ghost. Unlike the rest of the line's behaviour, that failure is
    // not merely cosmetic, which is why it is the one worth asserting.
    setRuntime({
      phase: "awaiting_user",
      detail: `edit → ${"apps/evil-jelly/src/cli/ui/viewers/".repeat(4)}MarkdownViewer.tsx`,
    });

    for (const columns of [40, 60, 80, 120]) {
      for (const row of statusLine(columns).split("\n")) {
        expect(stringWidth(row)).toBeLessThanOrEqual(columns);
      }
    }
  });

  it("counts the whole turn, not the current phase", () => {
    // The number's entire job is to expose a stall, so it must survive the phase changes a turn
    // walks through. Anchored to the phase it would restart on each one and never grow.
    setRuntime({ phase: "streaming", turnAgeSeconds: 30, phaseAgeSeconds: 1 });

    const seconds = displayedSeconds(statusLine());
    expect(seconds).not.toBeNull();
    expect(seconds!).toBeGreaterThanOrEqual(29);
  });

  it("falls back to the phase when a maintenance command runs without a turn", () => {
    // `/compress` reaches the model without passing the shell's turn anchor. With no fallback the
    // line read "0s" for the whole operation — a stall indicator that cannot count.
    setRuntime({ phase: "compacting", turnAgeSeconds: null, phaseAgeSeconds: 8 });

    const seconds = displayedSeconds(statusLine());
    expect(seconds).not.toBeNull();
    expect(seconds!).toBeGreaterThanOrEqual(7);
  });

  it("shows no number in the phases that park on the user", () => {
    // Both branches are static text; a number there would be counting something nobody is waiting
    // on, and it is what keeps the 1 Hz tick from running at an idle prompt.
    setRuntime({ phase: "idle" });
    expect(displayedSeconds(statusLine())).toBeNull();

    setRuntime({ phase: "awaiting_user", detail: "shell → workspace root" });
    expect(displayedSeconds(statusLine())).toBeNull();
  });

  it("names what the agent is waiting to be allowed to do", () => {
    setRuntime({ phase: "awaiting_user", detail: "shell → workspace root" });
    expect(statusLine()).toContain("shell → workspace root");
  });

  it("drops a detail that only restates the phase", () => {
    setRuntime({ phase: "awaiting_user", detail: "Waiting for input" });
    expect(statusLine()).not.toContain("Waiting for input");
  });
});
