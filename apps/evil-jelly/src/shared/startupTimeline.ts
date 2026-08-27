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

export interface StartupTimelineLateMilestone {
  readonly type: "evil_jelly_startup_profile_late_milestone";
  readonly version: 1;
  readonly name: string;
  readonly atMs: number;
  readonly sinceInputReadyMs?: number;
}

function milestoneDelta(report: StartupTimelineReport, name: string): number | undefined {
  return report.milestones.find((milestone) => milestone.name === name)?.deltaMs;
}

function milestoneAt(report: StartupTimelineReport, name: string): number | undefined {
  return report.milestones.find((milestone) => milestone.name === name)?.atMs;
}

function milestoneSpan(
  report: StartupTimelineReport,
  startName: string,
  endName: string,
): number | undefined {
  const startMs = milestoneAt(report, startName);
  const endMs = milestoneAt(report, endName);
  return startMs === undefined || endMs === undefined ? undefined : endMs - startMs;
}

const moduleReadyLabels = [
  ["unified_run_module_ready", "unified"],
  ["background_bindings_module_ready", "background"],
  ["cli_bindings_module_ready", "cli"],
  ["model_composition_module_ready", "model"],
] as const;

function slowestModuleReady(
  report: StartupTimelineReport,
): { label: string; durationMs: number } | undefined {
  const startedAtMs = milestoneAt(report, "unified_imports_started");
  if (startedAtMs === undefined) return undefined;

  return moduleReadyLabels.reduce<{ label: string; durationMs: number } | undefined>(
    (slowest, [name, label]) => {
      const readyAtMs = milestoneAt(report, name);
      if (readyAtMs === undefined) return slowest;
      const candidate = { label, durationMs: readyAtMs - startedAtMs };
      return slowest === undefined || candidate.durationMs > slowest.durationMs
        ? candidate
        : slowest;
    },
    undefined,
  );
}

/** Compact human-readable projection; the complete machine-readable report stays on stderr. */
export function formatStartupTimelineSummary(report: StartupTimelineReport): string {
  const parts = [`Startup profile: ${Math.round(report.totalMs)} ms total`];
  const modulesMs =
    milestoneSpan(report, "env_ready", "unified_modules_ready") ??
    milestoneDelta(report, "unified_modules_ready");
  if (modulesMs !== undefined) {
    const slowest = slowestModuleReady(report);
    const detail = slowest
      ? ` (slowest ${slowest.label} ${Math.round(slowest.durationMs)} ms)`
      : "";
    parts.push(`modules ${Math.round(modulesMs)} ms${detail}`);
  }
  const envMs =
    milestoneSpan(report, "workspace_ready", "env_ready") ?? milestoneDelta(report, "env_ready");
  if (envMs !== undefined) {
    parts.push(`env ${Math.round(envMs)} ms`);
  }
  const bindingsMs =
    milestoneSpan(report, "session_resolved", "ink_mounted") ??
    milestoneDelta(report, "ink_mounted");
  if (bindingsMs !== undefined) {
    const renderMs = milestoneSpan(report, "ink_render_started", "ink_render_returned");
    const detail = renderMs === undefined ? "" : ` (render ${Math.round(renderMs)} ms)`;
    parts.push(`bindings+Ink ${Math.round(bindingsMs)} ms${detail}`);
  }
  const inkMounted = report.milestones.find((milestone) => milestone.name === "ink_mounted");
  if (inkMounted) {
    parts.push(`post-bindings ${Math.round(report.totalMs - inkMounted.atMs)} ms`);
  }
  return `${parts.join(" · ")}.`;
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
  emitLateMilestone: (name: string) => StartupTimelineLateMilestone | undefined;
} {
  const now = options.now ?? (() => performance.now());
  const enabled = options.enabled ?? startupTimelineEnabled;
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
