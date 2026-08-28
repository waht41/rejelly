import { describe, expect, it } from "vitest";
import { formatStartupTimelineSummary } from "./summary";
import type { StartupTimelineReport } from "./timeline";

const milestone = (name: string, atMs: number) => ({ name, atMs, deltaMs: 0 });

function report(
  totalMs: number,
  milestones: StartupTimelineReport["milestones"],
): StartupTimelineReport {
  return {
    type: "evil_jelly_startup_profile",
    version: 1,
    totalMs,
    milestones,
  };
}

describe("startup profile summary", () => {
  it("summarizes detailed milestones without counting a delayed join observation as imports", () => {
    const summary = formatStartupTimelineSummary(
      report(200, [
        milestone("workspace_ready", 10),
        milestone("env_ready", 30),
        milestone("unified_imports_started", 31),
        milestone("background_bindings_module_ready", 40),
        milestone("model_composition_module_ready", 50),
        milestone("unified_run_module_ready", 60),
        milestone("cli_bindings_module_ready", 90),
        milestone("unified_imports_ready", 90),
        milestone("session_resolved", 100),
        milestone("cli_bindings_started", 101),
        milestone("ink_render_started", 110),
        milestone("ink_render_returned", 160),
        milestone("ink_mounted", 170),
        milestone("input_ready", 200),
      ]),
    );

    expect(summary).toBe(
      "Startup profile: 200 ms total · modules 60 ms (slowest cli 59 ms) · env 20 ms · bindings+Ink 70 ms (render 50 ms) · post-bindings 30 ms.",
    );
  });

  it("renders the startup critical path when Ink mounts before session resolution", () => {
    const summary = formatStartupTimelineSummary(
      report(300, [
        milestone("unified_imports_started", 20),
        milestone("cli_bindings_started", 100),
        milestone("ink_render_started", 110),
        milestone("ink_render_returned", 190),
        milestone("ink_mounted", 200),
        milestone("unified_imports_ready", 250),
        milestone("unified_modules_ready", 250),
        milestone("session_resolved", 260),
        milestone("runtime_ready", 290),
        milestone("input_ready", 300),
      ]),
    );

    expect(summary).toContain("Startup: 300 ms");
    expect(summary).toContain("Imports⁺");
    expect(summary).toContain("20 → 250  (230 ms)");
    expect(summary).toContain("Ink");
    expect(summary).toContain("100 → 200  (100 ms)");
    expect(summary).toContain("Runtime");
    expect(summary).toContain("250 → 290  (40 ms)");
    expect(summary).toContain("Input");
    expect(summary).toContain("290 → 300  (10 ms)");
    expect(summary).toContain("Both ready");
    expect(summary).toContain("Ready");
    expect(summary).toContain("█ critical path · ▒ overlapped/hidden · ▲ milestone");
    expect(summary).toContain("⁺ drill-down available: --profile startup:imports");
    expect(summary).toContain("1 cell ≈ 8 ms · numeric times are exact");
  });

  it("ends imports at actual completion rather than after a blocking Ink mount", () => {
    const summary = formatStartupTimelineSummary(
      report(1_576, [
        milestone("unified_imports_started", 123),
        milestone("unified_run_module_started", 123),
        milestone("background_bindings_module_started", 124),
        milestone("cli_bindings_module_started", 124),
        milestone("model_composition_module_started", 125),
        milestone("background_bindings_module_ready", 166),
        milestone("model_composition_module_ready", 274),
        milestone("unified_run_module_ready", 654),
        milestone("cli_bindings_module_ready", 672),
        milestone("unified_imports_ready", 672),
        milestone("cli_bindings_started", 673),
        milestone("ink_mounted", 1_480),
        milestone("unified_modules_ready", 1_499),
        milestone("runtime_ready", 1_569),
        milestone("input_ready", 1_576),
      ]),
      { selectors: ["startup", "startup:imports"] },
    );

    expect(summary).toContain("123 → 672  (549 ms)");
    expect(summary).toContain("673 → 1480  (807 ms)");
    expect(summary).toContain("1480 → 1569  (89 ms)");
    expect(summary).not.toContain("123 → 1499");
    expect(summary).toContain("Imports drill-down: 549 ms");
    expect(summary).toContain("runUnified");
    expect(summary).toContain("123 → 654  (531 ms)");
    expect(summary).toContain("cliBinding");
    expect(summary).toContain("124 → 672  (548 ms)");
    expect(summary).toContain("Import join");
    expect(summary).toContain("@ 672 ms");
    expect(summary).toContain("bars are wall-clock Promise spans, not exclusive CPU time");
    expect(summary.indexOf("Startup: 1576 ms")).toBeLessThan(
      summary.indexOf("Imports drill-down: 549 ms"),
    );
  });
});
