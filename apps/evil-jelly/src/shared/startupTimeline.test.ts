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
    });

    timeline.mark("before_env_load");
    process.env[STARTUP_PROFILE_ENV] = "true";
    expect(timeline.finish("input_ready")?.milestones).toHaveLength(2);
    expect(output).toHaveLength(1);
  });

  it("stays silent when profiling is disabled", () => {
    const output: string[] = [];
    const timeline = createStartupTimeline({
      now: () => 10,
      enabled: () => false,
      write: (line) => output.push(line),
    });

    timeline.mark("cli_module_ready");
    expect(timeline.finish("input_ready")).toBeUndefined();
    expect(output).toEqual([]);
  });
});
