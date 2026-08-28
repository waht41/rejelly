import { type ProfileSelector, selectedStartupProfileViews } from "./selection";
import type { StartupTimelineReport } from "./timeline";

export interface StartupTimelineSummaryOptions {
  readonly selectors?: readonly ProfileSelector[];
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

const moduleImportDefinitions = [
  ["unified_run_module_started", "unified_run_module_ready", "runUnified", "unified"],
  [
    "background_bindings_module_started",
    "background_bindings_module_ready",
    "background",
    "background",
  ],
  ["cli_bindings_module_started", "cli_bindings_module_ready", "cliBinding", "cli"],
  ["model_composition_module_started", "model_composition_module_ready", "model", "model"],
] as const;

function importPhaseReadyAt(report: StartupTimelineReport): number | undefined {
  return milestoneAt(report, "unified_imports_ready");
}

function slowestModuleReady(
  report: StartupTimelineReport,
): { label: string; durationMs: number } | undefined {
  const startedAtMs = milestoneAt(report, "unified_imports_started");
  if (startedAtMs === undefined) return undefined;

  return moduleImportDefinitions.reduce<{ label: string; durationMs: number } | undefined>(
    (slowest, [, readyName, , summaryLabel]) => {
      const readyAtMs = milestoneAt(report, readyName);
      if (readyAtMs === undefined) return slowest;
      const candidate = { label: summaryLabel, durationMs: readyAtMs - startedAtMs };
      return slowest === undefined || candidate.durationMs > slowest.durationMs
        ? candidate
        : slowest;
    },
    undefined,
  );
}

const GANTT_WIDTH = 40;
const GANTT_LABEL_WIDTH = 13;

interface GanttSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly fill: "█" | "▒";
}

function splitGanttSegmentByWindow(
  startMs: number,
  endMs: number,
  windowStartMs: number | undefined,
  windowEndMs: number | undefined,
): GanttSegment[] {
  if (
    windowStartMs === undefined ||
    windowEndMs === undefined ||
    windowEndMs <= startMs ||
    windowStartMs >= endMs
  ) {
    return [{ startMs, endMs, fill: "█" }];
  }

  const overlapStartMs = Math.max(startMs, windowStartMs);
  const overlapEndMs = Math.min(endMs, windowEndMs);
  const segments: GanttSegment[] = [];
  if (startMs < overlapStartMs) {
    segments.push({ startMs, endMs: overlapStartMs, fill: "█" });
  }
  segments.push({ startMs: overlapStartMs, endMs: overlapEndMs, fill: "▒" });
  if (overlapEndMs < endMs) {
    segments.push({ startMs: overlapEndMs, endMs, fill: "█" });
  }
  return segments;
}

function ganttPosition(atMs: number, totalMs: number): number {
  return Math.round((atMs / totalMs) * GANTT_WIDTH);
}

function renderGanttBar(
  totalMs: number,
  segments: readonly GanttSegment[],
  guidePositions: readonly number[],
): string {
  const cells = Array<string>(GANTT_WIDTH + 1).fill(" ");
  for (const position of guidePositions) {
    cells[position] = "┊";
  }
  cells[0] = "│";
  cells[GANTT_WIDTH] = "│";
  for (const segment of segments) {
    const start = Math.max(
      1,
      Math.min(GANTT_WIDTH - 1, Math.floor((segment.startMs / totalMs) * GANTT_WIDTH)),
    );
    const end = Math.max(
      start + 1,
      Math.min(GANTT_WIDTH, Math.ceil((segment.endMs / totalMs) * GANTT_WIDTH)),
    );
    for (let index = start; index < end; index += 1) {
      cells[index] = segment.fill;
    }
  }
  return cells.join("");
}

function niceGanttStep(totalMs: number): number {
  const target = totalMs / 4;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const normalized = target / magnitude;
  const factor = [1, 2, 2.5, 5, 10].find((candidate) => candidate >= normalized) ?? 10;
  return factor * magnitude;
}

function renderGanttAxis(
  totalMs: number,
  offsetMs = 0,
): {
  labels: string;
  ruler: string;
  guidePositions: readonly number[];
} {
  const labels = Array<string>(GANTT_WIDTH + 1).fill(" ");
  const occupied = Array<boolean>(GANTT_WIDTH + 1).fill(false);
  const ruler = Array<string>(GANTT_WIDTH + 1).fill("─");
  const place = (text: string, start: number): void => {
    for (let index = 0; index < text.length; index += 1) {
      labels[start + index] = text[index] ?? " ";
      occupied[start + index] = true;
    }
  };

  place(String(Math.round(offsetMs)), 0);
  const totalLabel = String(Math.round(offsetMs + totalMs));
  const totalLabelStart = GANTT_WIDTH - totalLabel.length + 1;
  place(totalLabel, totalLabelStart);
  ruler[0] = "│";
  ruler[GANTT_WIDTH] = "│";
  const guidePositions: number[] = [];

  const step = niceGanttStep(totalMs);
  for (let tickMs = step; tickMs < totalMs; tickMs += step) {
    const text = String(Math.round(offsetMs + tickMs));
    const position = ganttPosition(tickMs, totalMs);
    const start = Math.max(0, position - Math.floor(text.length / 2));
    const end = start + text.length;
    const hasCollision =
      end > labels.length || occupied.slice(Math.max(0, start - 1), end + 1).some(Boolean);
    if (hasCollision) continue;
    place(text, start);
    ruler[position] = "│";
    guidePositions.push(position);
  }

  return { labels: `${labels.join("")} ms`, ruler: ruler.join(""), guidePositions };
}

function renderGanttRow(
  label: string,
  totalMs: number,
  startMs: number,
  endMs: number,
  segments: readonly GanttSegment[],
  guidePositions: readonly number[],
  barOffsetMs = 0,
): string {
  const barSegments = segments.map((segment) => ({
    ...segment,
    startMs: segment.startMs - barOffsetMs,
    endMs: segment.endMs - barOffsetMs,
  }));
  return `${label.padEnd(GANTT_LABEL_WIDTH)}${renderGanttBar(totalMs, barSegments, guidePositions)}  ${Math.round(startMs)} → ${Math.round(endMs)}  (${Math.round(endMs - startMs)} ms)`;
}

function renderGanttMilestone(
  label: string,
  totalMs: number,
  atMs: number,
  barOffsetMs = 0,
): string {
  const cells = Array<string>(GANTT_WIDTH + 1).fill(" ");
  cells[0] = "│";
  cells[GANTT_WIDTH] = "│";
  cells[Math.max(1, Math.min(GANTT_WIDTH, ganttPosition(atMs - barOffsetMs, totalMs)))] = "▲";
  return `${label.padEnd(GANTT_LABEL_WIDTH)}${cells.join("")}  @ ${Math.round(atMs)} ms`;
}

function formatStartupGantt(report: StartupTimelineReport): string | undefined {
  const importsStartedAt = milestoneAt(report, "unified_imports_started");
  const importsReadyAt = importPhaseReadyAt(report);
  const inkStartedAt = milestoneAt(report, "cli_bindings_started");
  const inkReadyAt = milestoneAt(report, "ink_mounted");
  const runtimeReadyAt = milestoneAt(report, "runtime_ready");
  const inputReadyAt = milestoneAt(report, "input_ready");
  if (
    importsStartedAt === undefined ||
    importsReadyAt === undefined ||
    inkStartedAt === undefined ||
    inkReadyAt === undefined ||
    runtimeReadyAt === undefined ||
    inputReadyAt === undefined ||
    report.totalMs <= 0
  ) {
    return undefined;
  }

  const overlapStart = Math.max(importsStartedAt, inkStartedAt);
  const overlapEnd = Math.min(importsReadyAt, inkReadyAt);
  const hasOverlap = overlapEnd > overlapStart;
  const importsDetermineJoin = importsReadyAt >= inkReadyAt;
  const importSegments: GanttSegment[] = [
    { startMs: importsStartedAt, endMs: importsReadyAt, fill: "█" },
  ];
  const inkSegments: GanttSegment[] = [{ startMs: inkStartedAt, endMs: inkReadyAt, fill: "█" }];
  if (hasOverlap) {
    (importsDetermineJoin ? inkSegments : importSegments).push({
      startMs: overlapStart,
      endMs: overlapEnd,
      fill: "▒",
    });
  }
  const joinedAt = Math.max(importsReadyAt, inkReadyAt);
  const runtimeSegments: GanttSegment[] = [{ startMs: joinedAt, endMs: runtimeReadyAt, fill: "█" }];
  const inputSegments: GanttSegment[] = [
    { startMs: runtimeReadyAt, endMs: inputReadyAt, fill: "█" },
  ];
  const axis = renderGanttAxis(report.totalMs);
  const indent = " ".repeat(GANTT_LABEL_WIDTH);

  return [
    `Startup: ${Math.round(report.totalMs)} ms`,
    `${indent}${axis.labels}`,
    `${indent}${axis.ruler}`,
    renderGanttRow(
      "Imports⁺",
      report.totalMs,
      importsStartedAt,
      importsReadyAt,
      importSegments,
      axis.guidePositions,
    ),
    renderGanttRow(
      "Ink⁺",
      report.totalMs,
      inkStartedAt,
      inkReadyAt,
      inkSegments,
      axis.guidePositions,
    ),
    renderGanttRow(
      "Runtime",
      report.totalMs,
      joinedAt,
      runtimeReadyAt,
      runtimeSegments,
      axis.guidePositions,
    ),
    renderGanttRow(
      "Input",
      report.totalMs,
      runtimeReadyAt,
      inputReadyAt,
      inputSegments,
      axis.guidePositions,
    ),
    renderGanttMilestone("Both ready", report.totalMs, joinedAt),
    renderGanttMilestone("Ready", report.totalMs, inputReadyAt),
    `${indent}█ critical path · ▒ overlap window · ▲ milestone`,
    `${indent}⁺ drill-down: startup:imports · startup:ink`,
    `${indent}1 cell ≈ ${Math.round(report.totalMs / GANTT_WIDTH)} ms · numeric times are exact`,
  ].join("\n");
}

function formatImportsDrilldownGantt(report: StartupTimelineReport): string | undefined {
  const importsStartedAt = milestoneAt(report, "unified_imports_started");
  const importsReadyAt = importPhaseReadyAt(report);
  const inkStartedAt = milestoneAt(report, "cli_bindings_started");
  const inkReadyAt = milestoneAt(report, "ink_mounted");
  if (
    importsStartedAt === undefined ||
    importsReadyAt === undefined ||
    importsReadyAt <= importsStartedAt
  ) {
    return undefined;
  }

  const spans = moduleImportDefinitions.flatMap(([startedName, readyName, label]) => {
    const readyAt = milestoneAt(report, readyName);
    if (readyAt === undefined) return [];
    return [
      {
        label,
        startAt: milestoneAt(report, startedName) ?? importsStartedAt,
        readyAt,
      },
    ];
  });
  if (spans.length === 0) return undefined;

  const slowestReadyAt = Math.max(...spans.map((span) => span.readyAt));
  const durationMs = importsReadyAt - importsStartedAt;
  const axis = renderGanttAxis(durationMs, importsStartedAt);
  const indent = " ".repeat(GANTT_LABEL_WIDTH);
  const rows = [
    `Import availability: ${Math.round(durationMs)} ms`,
    `${indent}${axis.labels}`,
    `${indent}${axis.ruler}`,
  ];
  for (const span of spans) {
    const determinesJoin = span.readyAt === slowestReadyAt;
    rows.push(
      renderGanttRow(
        determinesJoin ? `${span.label}*` : span.label,
        durationMs,
        span.startAt,
        span.readyAt,
        splitGanttSegmentByWindow(span.startAt, span.readyAt, inkStartedAt, inkReadyAt),
        axis.guidePositions,
        importsStartedAt,
      ),
    );
  }
  if (inkStartedAt !== undefined && inkReadyAt !== undefined) {
    const overlapStartAt = Math.max(importsStartedAt, inkStartedAt);
    const overlapEndAt = Math.min(importsReadyAt, inkReadyAt);
    if (overlapEndAt > overlapStartAt) {
      rows.push(
        renderGanttRow(
          "Ink overlap",
          durationMs,
          overlapStartAt,
          overlapEndAt,
          [{ startMs: overlapStartAt, endMs: overlapEndAt, fill: "▒" }],
          axis.guidePositions,
          importsStartedAt,
        ),
      );
    }
  }
  rows.push(
    renderGanttMilestone("Import join", durationMs, importsReadyAt, importsStartedAt),
    `${indent}* determines import join · █ outside Ink · ▒ overlaps Ink window`,
    `${indent}wall-clock availability; ▒ may include main-thread scheduling delay`,
  );
  return rows.join("\n");
}

function formatInkDrilldownGantt(report: StartupTimelineReport): string | undefined {
  const bindingsStartedAt = milestoneAt(report, "cli_bindings_started");
  const renderStartedAt = milestoneAt(report, "ink_render_started");
  const renderReturnedAt = milestoneAt(report, "ink_render_returned");
  const inkReadyAt = milestoneAt(report, "ink_mounted");
  if (
    bindingsStartedAt === undefined ||
    renderStartedAt === undefined ||
    renderReturnedAt === undefined ||
    inkReadyAt === undefined ||
    renderStartedAt < bindingsStartedAt ||
    renderReturnedAt < renderStartedAt ||
    inkReadyAt < renderReturnedAt
  ) {
    return undefined;
  }

  const durationMs = inkReadyAt - bindingsStartedAt;
  if (durationMs <= 0) return undefined;
  const axis = renderGanttAxis(durationMs, bindingsStartedAt);
  const indent = " ".repeat(GANTT_LABEL_WIDTH);
  const rows = [
    `Ink drill-down: ${Math.round(durationMs)} ms`,
    `${indent}${axis.labels}`,
    `${indent}${axis.ruler}`,
    renderGanttRow(
      "Bindings",
      durationMs,
      bindingsStartedAt,
      renderStartedAt,
      [{ startMs: bindingsStartedAt, endMs: renderStartedAt, fill: "█" }],
      axis.guidePositions,
      bindingsStartedAt,
    ),
    renderGanttRow(
      "Ink render",
      durationMs,
      renderStartedAt,
      renderReturnedAt,
      [{ startMs: renderStartedAt, endMs: renderReturnedAt, fill: "█" }],
      axis.guidePositions,
      bindingsStartedAt,
    ),
    renderGanttRow(
      "Post-render",
      durationMs,
      renderReturnedAt,
      inkReadyAt,
      [{ startMs: renderReturnedAt, endMs: inkReadyAt, fill: "█" }],
      axis.guidePositions,
      bindingsStartedAt,
    ),
  ];
  for (const [label, milestoneName] of [
    ["Session reset", "cli_session_reset"],
    ["Submission", "cli_submission_ready"],
    ["Shell start", "ink_shell_started"],
    ["Composer", "composer_mounted"],
    ["Render return", "ink_render_returned"],
    ["Ink ready", "ink_mounted"],
  ] as const) {
    const atMs = milestoneAt(report, milestoneName);
    if (atMs !== undefined) {
      rows.push(renderGanttMilestone(label, durationMs, atMs, bindingsStartedAt));
    }
  }
  rows.push(
    `${indent}█ phase wall time · ▲ internal milestone`,
    `${indent}numeric times are exact; renderer phases are not exclusive CPU samples`,
  );
  return rows.join("\n");
}

function formatStartupOverview(report: StartupTimelineReport): string {
  const gantt = formatStartupGantt(report);
  const parts = [`Startup profile: ${Math.round(report.totalMs)} ms total`];
  const envReadyAt = milestoneAt(report, "env_ready");
  const importsReadyAt = importPhaseReadyAt(report);
  const modulesMs =
    envReadyAt !== undefined && importsReadyAt !== undefined
      ? importsReadyAt - envReadyAt
      : undefined;
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
  const sessionResolvedAt = milestoneAt(report, "session_resolved");
  const inkMountedAt = milestoneAt(report, "ink_mounted");
  const bindingsMs =
    sessionResolvedAt !== undefined &&
    inkMountedAt !== undefined &&
    sessionResolvedAt <= inkMountedAt
      ? inkMountedAt - sessionResolvedAt
      : (milestoneSpan(report, "cli_bindings_started", "ink_mounted") ??
        milestoneDelta(report, "ink_mounted"));
  if (bindingsMs !== undefined) {
    const renderMs = milestoneSpan(report, "ink_render_started", "ink_render_returned");
    const detail = renderMs === undefined ? "" : ` (render ${Math.round(renderMs)} ms)`;
    parts.push(`bindings+Ink ${Math.round(bindingsMs)} ms${detail}`);
  }
  const inkMounted = report.milestones.find((milestone) => milestone.name === "ink_mounted");
  if (inkMounted) {
    parts.push(`post-bindings ${Math.round(report.totalMs - inkMounted.atMs)} ms`);
  }
  return gantt ?? `${parts.join(" · ")}.`;
}

/** Renders the selected startup profile views in selector order. */
export function formatStartupTimelineSummary(
  report: StartupTimelineReport,
  options: StartupTimelineSummaryOptions = {},
): string {
  const selectors = options.selectors ?? selectedStartupProfileViews();
  return selectors
    .map((selector) => {
      if (selector === "startup") return formatStartupOverview(report);
      if (selector === "startup:imports") {
        return (
          formatImportsDrilldownGantt(report) ??
          "Profile startup:imports: required milestones were not recorded."
        );
      }
      return (
        formatInkDrilldownGantt(report) ??
        "Profile startup:ink: required milestones were not recorded."
      );
    })
    .join("\n\n");
}
