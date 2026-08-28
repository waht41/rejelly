import { afterEach, describe, expect, it } from "vitest";
import {
  createStartupTimeline,
  formatStartupTimelineSummary,
  STARTUP_PROFILE_ENV,
} from "./startupTimeline";

const originalStartupProfileEnv = process.env[STARTUP_PROFILE_ENV];

afterEach(() => {
  if (originalStartupProfileEnv === undefined) {
    delete process.env[STARTUP_PROFILE_ENV];
  } else {
    process.env[STARTUP_PROFILE_ENV] = originalStartupProfileEnv;
  }
});

describe("startup timeline", () => {
  it("emits one process-relative report with milestone deltas", () => {
    const times = [125.123, 380.456, 410.789];
    const output: string[] = [];
    const timeline = createStartupTimeline({
      now: () => times.shift()!,
      enabled: () => true,
      write: (line) => output.push(line),
      isStderrTTY: () => false,
    });

    timeline.mark("cli_module_ready");
    timeline.mark("unified_modules_ready");
    const report = timeline.finish("input_ready");

    expect(report).toEqual({
      type: "evil_jelly_startup_profile",
      version: 1,
      totalMs: 410.79,
      milestones: [
        { name: "cli_module_ready", atMs: 125.12, deltaMs: 125.12 },
        { name: "unified_modules_ready", atMs: 380.46, deltaMs: 255.34 },
        { name: "input_ready", atMs: 410.79, deltaMs: 30.33 },
      ],
    });
    expect(output).toEqual([`[evil-jelly:startup-profile] ${JSON.stringify(report)}\n`]);
    expect(formatStartupTimelineSummary(report!)).toBe(
      "Startup profile: 411 ms total · modules 255 ms.",
    );
    expect(timeline.finish("ignored")).toBeUndefined();
    expect(output).toHaveLength(1);
  });

  it("keeps recording before the dynamic environment switch is enabled", () => {
    const output: string[] = [];
    delete process.env[STARTUP_PROFILE_ENV];
    const timeline = createStartupTimeline({
      now: () => 25,
      write: (line) => output.push(line),
      isStderrTTY: () => false,
    });

    timeline.mark("before_env_load");
    process.env[STARTUP_PROFILE_ENV] = "true";
    expect(timeline.finish("input_ready")?.milestones).toHaveLength(2);
    expect(output).toHaveLength(1);
  });

  it("emits a first-occurrence late milestone without extending startup total", () => {
    const times = [100, 160];
    const output: string[] = [];
    const timeline = createStartupTimeline({
      now: () => times.shift()!,
      enabled: () => true,
      write: (line) => output.push(line),
      isStderrTTY: () => false,
    });

    expect(timeline.emitLateMilestone("first_input_dispatched")).toBeUndefined();
    const report = timeline.finish("input_ready");
    const lateMilestone = timeline.emitLateMilestone("first_input_dispatched");

    expect(report?.totalMs).toBe(100);
    expect(lateMilestone).toEqual({
      type: "evil_jelly_startup_profile_late_milestone",
      version: 1,
      name: "first_input_dispatched",
      atMs: 160,
      sinceInputReadyMs: 60,
    });
    expect(timeline.emitLateMilestone("first_input_dispatched")).toBeUndefined();
    expect(output).toHaveLength(2);
    expect(output[1]).toBe(`[evil-jelly:startup-profile-late] ${JSON.stringify(lateMilestone)}\n`);
  });

  it("keeps phase summaries stable when detailed milestones are present", () => {
    const times = [
      10, 30, 31, 40, 50, 60, 90, 91, 100, 101, 103, 105, 106, 110, 160, 161, 169, 170, 200,
    ];
    const timeline = createStartupTimeline({
      now: () => times.shift()!,
      enabled: () => true,
      write: () => undefined,
      isStderrTTY: () => false,
    });

    timeline.mark("workspace_ready");
    timeline.mark("env_ready");
    timeline.mark("unified_imports_started");
    timeline.mark("background_bindings_module_ready");
    timeline.mark("model_composition_module_ready");
    timeline.mark("unified_run_module_ready");
    timeline.mark("cli_bindings_module_ready");
    timeline.mark("unified_modules_ready");
    timeline.mark("session_resolved");
    timeline.mark("cli_bindings_started");
    timeline.mark("cli_session_reset");
    timeline.mark("cli_submission_ready");
    timeline.mark("ink_shell_started");
    timeline.mark("ink_render_started");
    timeline.mark("ink_render_returned");
    timeline.mark("cli_shell_ready");
    timeline.mark("cli_bindings_ready");
    timeline.mark("ink_mounted");
    const report = timeline.finish("input_ready");

    expect(formatStartupTimelineSummary(report!)).toBe(
      "Startup profile: 200 ms total · modules 61 ms (slowest cli 59 ms) · env 20 ms · bindings+Ink 70 ms (render 50 ms) · post-bindings 30 ms.",
    );
  });

  it("summarizes bindings when Ink mounts before session resolution", () => {
    const times = [20, 100, 110, 190, 200, 250, 260, 290, 300];
    const timeline = createStartupTimeline({
      now: () => times.shift()!,
      enabled: () => true,
      write: () => undefined,
      isStderrTTY: () => false,
    });

    timeline.mark("unified_imports_started");
    timeline.mark("cli_bindings_started");
    timeline.mark("ink_render_started");
    timeline.mark("ink_render_returned");
    timeline.mark("ink_mounted");
    timeline.mark("unified_modules_ready");
    timeline.mark("session_resolved");
    timeline.mark("runtime_ready");
    const report = timeline.finish("input_ready");

    const summary = formatStartupTimelineSummary(report!);
    expect(summary).toContain("Startup: 300 ms");
    expect(summary).toContain("Imports");
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
    expect(summary).toContain("1 cell ≈ 8 ms · numeric times are exact");
  });

  it("stays silent when profiling is disabled", () => {
    const output: string[] = [];
    const timeline = createStartupTimeline({
      now: () => 10,
      enabled: () => false,
      write: (line) => output.push(line),
      isStderrTTY: () => false,
    });

    timeline.mark("cli_module_ready");
    expect(timeline.finish("input_ready")).toBeUndefined();
    expect(output).toEqual([]);
  });

  it("keeps successful machine reports out of an Ink TTY", () => {
    const output: string[] = [];
    const timeline = createStartupTimeline({
      now: () => 25,
      enabled: () => true,
      write: (line) => output.push(line),
      isStderrTTY: () => true,
    });

    expect(timeline.finish("input_ready")?.totalMs).toBe(25);
    expect(output).toEqual([]);
  });

  it("still writes a failure report when a TTY process exits before input is ready", () => {
    const output: string[] = [];
    const timeline = createStartupTimeline({
      now: () => 25,
      enabled: () => true,
      write: (line) => output.push(line),
      isStderrTTY: () => true,
    });

    timeline.finish("process_exit");

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('"name":"process_exit"');
  });
});
