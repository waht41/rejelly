import { performance } from "node:perf_hooks";

export const STARTUP_PROFILE_ENV = "EVIL_STARTUP_PROFILE";

interface StartupMilestone {
  readonly name: string;
  readonly atMs: number;
}

export interface StartupTimelineReport {
  readonly type: "evil_jelly_startup_profile";
  readonly version: 1;
  readonly totalMs: number;
  readonly milestones: readonly {
    readonly name: string;
    readonly atMs: number;
    readonly deltaMs: number;
  }[];
}

interface StartupTimelineOptions {
  readonly now?: () => number;
  readonly enabled?: () => boolean;
  readonly write?: (line: string) => void;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function startupTimelineEnabled(): boolean {
  // biome-ignore lint/style/noProcessEnv: profiling must be switchable before config/env loading.
  const value = process.env[STARTUP_PROFILE_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * Records process-relative startup milestones and emits one machine-readable report on finish.
 * `performance.now()` starts near process launch, so the first mark also includes static imports
 * evaluated before the CLI module body runs.
 */
export function createStartupTimeline(options: StartupTimelineOptions = {}): {
  mark: (name: string) => void;
  finish: (name: string) => StartupTimelineReport | undefined;
} {
  const now = options.now ?? (() => performance.now());
  const enabled = options.enabled ?? startupTimelineEnabled;
  const write = options.write ?? ((line: string) => process.stderr.write(line));
  const milestones: StartupMilestone[] = [];
  let finished = false;

  const mark = (name: string): void => {
    if (finished) return;
    milestones.push({ name, atMs: roundMs(now()) });
  };

  const finish = (name: string): StartupTimelineReport | undefined => {
    if (finished) return undefined;
    mark(name);
    finished = true;
    if (!enabled()) return undefined;

    let previousMs = 0;
    const reportedMilestones = milestones.map((milestone) => {
      const deltaMs = roundMs(milestone.atMs - previousMs);
      previousMs = milestone.atMs;
      return { ...milestone, deltaMs };
    });
    const report: StartupTimelineReport = {
      type: "evil_jelly_startup_profile",
      version: 1,
      totalMs: reportedMilestones.at(-1)?.atMs ?? 0,
      milestones: reportedMilestones,
    };
    write(`[evil-jelly:startup-profile] ${JSON.stringify(report)}\n`);
    return report;
  };

  return { mark, finish };
}

export const startupTimeline = createStartupTimeline();

// A failed startup is often the case that most needs timing data. Normal interactive startup
// finishes at `input_ready`; this is then a no-op when the process eventually exits.
process.once("exit", () => startupTimeline.finish("process_exit"));
