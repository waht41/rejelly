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
    expect(summary).toContain("Ink⁺");
    expect(summary).toContain("█ critical path · ▒ overlap window · ▲ milestone");
    expect(summary).toContain("⁺ drill-down: startup:imports · startup:ink");
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
    expect(summary).toContain("Import availability: 549 ms");
    expect(summary).toContain("runUnified");
    expect(summary).toContain("123 → 654  (531 ms)");
    expect(summary).toContain("cliBinding*");
    expect(summary).toContain("124 → 672  (548 ms)");
    expect(summary).toContain("Import join");
    expect(summary).toContain("@ 672 ms");
    expect(summary).toContain("* determines import join · █ outside Ink · ▒ overlaps Ink window");
    expect(summary).toContain(
      "wall-clock availability; ▒ may include main-thread scheduling delay",
    );
    expect(summary.indexOf("Startup: 1576 ms")).toBeLessThan(
      summary.indexOf("Import availability: 549 ms"),
    );
  });

  it("separates Ink overlap from an import availability span", () => {
    const summary = formatStartupTimelineSummary(
      report(1_680, [
        milestone("unified_imports_started", 119),
        milestone("unified_run_module_started", 119),
        milestone("background_bindings_module_started", 119),
        milestone("cli_bindings_module_started", 120),
        milestone("model_composition_module_started", 120),
        milestone("background_bindings_module_ready", 153),
        milestone("model_composition_module_ready", 264),
        milestone("cli_bindings_module_ready", 435),
        milestone("cli_bindings_started", 435),
        milestone("ink_mounted", 1_238),
        milestone("unified_run_module_ready", 1_599),
        milestone("unified_imports_ready", 1_599),
        milestone("runtime_ready", 1_670),
        milestone("input_ready", 1_680),
      ]),
      { selectors: ["startup:imports"] },
    );

    expect(summary).toContain("Import availability: 1480 ms");
    expect(summary).toContain("runUnified*");
    expect(summary).toContain("119 → 1599  (1480 ms)");
    expect(summary).toContain("Ink overlap");
    expect(summary).toContain("435 → 1238  (803 ms)");
    expect(summary).toContain(
      "wall-clock availability; ▒ may include main-thread scheduling delay",
    );
  });

  it("breaks the Ink window into binding, render, and post-render phases", () => {
    const summary = formatStartupTimelineSummary(
      report(1_609, [
        milestone("cli_bindings_started", 671),
        milestone("cli_session_reset", 672),
        milestone("cli_submission_ready", 673),
        milestone("ink_shell_started", 674),
        milestone("ink_render_started", 675),
        milestone("composer_mounted", 1_450),
        milestone("ink_render_returned", 1_508),
        milestone("cli_shell_ready", 1_508),
        milestone("cli_bindings_ready", 1_510),
        milestone("ink_mounted", 1_510),
      ]),
      { selectors: ["startup:ink"] },
    );

    expect(summary).toContain("Ink drill-down: 839 ms");
    expect(summary).toContain("Bindings");
    expect(summary).toContain("671 → 675  (4 ms)");
    expect(summary).toContain("Ink render");
    expect(summary).toContain("675 → 1508  (833 ms)");
    expect(summary).toContain("Post-render");
    expect(summary).toContain("1508 → 1510  (2 ms)");
    expect(summary).toContain("Composer");
    expect(summary).toContain("@ 1450 ms");
    expect(summary).toContain(
      "numeric times are exact; renderer phases are not exclusive CPU samples",
    );
  });
});
