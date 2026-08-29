import { performance } from "node:perf_hooks";
import { startupProfileEnabled } from "./selection";

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

export interface StartupTimelineLateMilestone {
  readonly type: "evil_jelly_startup_profile_late_milestone";
  readonly version: 1;
  readonly name: string;
  readonly atMs: number;
  readonly sinceInputReadyMs?: number;
}

interface StartupTimelineOptions {
  readonly now?: () => number;
  readonly enabled?: () => boolean;
  readonly write?: (line: string) => void;
  readonly isStderrTTY?: () => boolean;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Records process-relative startup milestones and emits one machine-readable report on finish.
 * `performance.now()` starts near process launch, so the first mark also includes static imports
 * evaluated before the CLI module body runs.
 */
export function createStartupTimeline(options: StartupTimelineOptions = {}): {
  mark: (name: string) => void;
  finish: (name: string) => StartupTimelineReport | undefined;
  emitLateMilestone: (name: string) => StartupTimelineLateMilestone | undefined;
} {
  const now = options.now ?? (() => performance.now());
  const enabled = options.enabled ?? startupProfileEnabled;
  const write = options.write ?? ((line: string) => process.stderr.write(line));
  const isStderrTTY = options.isStderrTTY ?? (() => process.stderr.isTTY === true);
  const milestones: StartupMilestone[] = [];
  const emittedLateMilestones = new Set<string>();
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
    // Ink patches stderr after mounting and renders writes as UI content. A full JSON line would
    // then wrap across the prompt and distort the layout, while the compact report is already
    // shown through Ink. Preserve machine output for pipes and failure diagnostics.
    if (!isStderrTTY() || name === "process_exit") {
      write(`[evil-jelly:startup-profile] ${JSON.stringify(report)}\n`);
    }
    return report;
  };

  const emitLateMilestone = (name: string): StartupTimelineLateMilestone | undefined => {
    if (!finished || emittedLateMilestones.has(name) || !enabled()) return undefined;
    emittedLateMilestones.add(name);
    const atMs = roundMs(now());
    const inputReadyMs = milestones.find((milestone) => milestone.name === "input_ready")?.atMs;
    const event: StartupTimelineLateMilestone = {
      type: "evil_jelly_startup_profile_late_milestone",
      version: 1,
      name,
      atMs,
      ...(inputReadyMs === undefined ? {} : { sinceInputReadyMs: roundMs(atMs - inputReadyMs) }),
    };
    // A late event can occur after the user has started editing. Keep raw machine output away
    // from Ink's patched stderr just like the successful startup report.
    if (!isStderrTTY()) {
      write(`[evil-jelly:startup-profile-late] ${JSON.stringify(event)}\n`);
    }
    return event;
  };

  return { mark, finish, emitLateMilestone };
}

export const startupTimeline = createStartupTimeline();

// A failed startup is often the case that most needs timing data. Normal interactive startup
// finishes at `input_ready`; this is then a no-op when the process eventually exits.
process.once("exit", () => startupTimeline.finish("process_exit"));
