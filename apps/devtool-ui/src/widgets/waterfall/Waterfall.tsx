/**
 * Waterfall view: aggregated spans from normalizedTrace.waterfall with timeline bars.
 * Data: normalizedTrace.waterfall.aggregatedSpans + aggregatedRootSpanIds (dual-written with legacy spanTree).
 * Single vertical scroll; left name column sticky on horizontal scroll.
 * Click row -> setActiveNode (DetailView shows in detail layout).
 */

import { useTraceStore } from "@entities/trace/store";
import type { NormalizedTrace, TraceEvent } from "@entities/trace/types";
import { AskAIButton } from "@features/command-view";
import { useToast } from "@shared/hooks/use-toast";
import { cn } from "@shared/lib/style";
import { useSelectionStore } from "@shared/store/useSelectionStore";
import { JsonViewer } from "@shared/ui/JsonViewer";
import {
  Activity,
  Bot,
  ChevronDown,
  ChevronRight,
  Code,
  Download,
  MessageSquare,
  Search,
  X,
  XCircle,
} from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { flattenSpanTree, type WaterfallRow } from "./waterfallData";

function CopyableId({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: (text: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onCopy(value);
      }}
      className="flex items-center gap-1.5 px-2 py-1 rounded border border-border bg-background hover:bg-muted transition-colors text-xs font-mono text-muted-foreground hover:text-foreground"
      title={`Click to copy ${label}`}
    >
      <span className="text-muted-foreground/80">{label}:</span>
      <span className="truncate max-w-[180px]">{value}</span>
    </button>
  );
}

const ROW_HEIGHT = 28;
const NAME_COLUMN_WIDTH = 280;
const TIMELINE_BASE_WIDTH = 600;
const DEPTH_INDENT = 16;
const MIN_ZOOM = 1;
const MAX_ZOOM = 10;

type DetailNodeType = "agent" | "span" | "runWith";
type WaterfallDetailTab = "overview" | "attributes" | "logs" | "error";

function getSpanTypeIcon(type: string) {
  switch (type) {
    case "agent":
      return <Bot className="w-3.5 h-3.5 text-tree-item-icon-agent shrink-0" />;
    case "runWith":
      return <Activity className="w-3.5 h-3.5 text-muted-foreground shrink-0" />;
    default:
      return <Code className="w-3.5 h-3.5 text-tree-item-icon-span shrink-0" />;
  }
}

const LOG_LEVELS: Array<"all" | NormalizedTrace.LogLevel> = [
  "all",
  "debug",
  "info",
  "warning",
  "error",
];

function isSysLogEvent(event: TraceEvent): event is TraceEvent & {
  level: NormalizedTrace.LogLevel;
  message: string;
  args?: unknown[];
} {
  const payload = event as unknown as Record<string, unknown>;
  return (
    event.type === "sys:log" &&
    (payload.level === "debug" ||
      payload.level === "info" ||
      payload.level === "warning" ||
      payload.level === "error")
  );
}

function collectLogEvents(
  span?: NormalizedTrace.AggregatedSpan,
  node?: NormalizedTrace.TraceNode,
): TraceEvent[] {
  const seen = new Set<string>();
  const events = [...(span?.logEvents ?? []), ...(node?.logEvents ?? [])].filter(isSysLogEvent);
  return events.filter((event) => {
    const payload = event as unknown as { _seq?: number; message?: string; level?: string };
    const key = [
      payload._seq ?? "",
      event.timestamp,
      event.trace?.spanId ?? "",
      event.type,
      payload.level ?? "",
      payload.message ?? "",
      compactJson((event as unknown as { args?: unknown }).args),
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getMaxLogLevelFromEvents(logEvents: TraceEvent[]): NormalizedTrace.LogLevel | undefined {
  let maxLevel: NormalizedTrace.LogLevel | undefined;
  for (const event of logEvents) {
    if (!isSysLogEvent(event)) continue;
    if (!maxLevel || LOG_LEVEL_ORDER[event.level] > LOG_LEVEL_ORDER[maxLevel]) {
      maxLevel = event.level;
    }
  }
  return maxLevel;
}

const LOG_LEVEL_ORDER: Record<NormalizedTrace.LogLevel, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
};

function getLevelClass(level: NormalizedTrace.LogLevel | undefined) {
  if (level === "error") return "border-destructive/40 bg-destructive/20 text-red-200";
  if (level === "warning") return "border-amber-500/40 bg-amber-500/20 text-amber-200";
  if (level === "info") return "border-blue-400/30 bg-blue-500/15 text-blue-100";
  return "border-muted bg-muted/70 text-muted-foreground";
}

function getWaterfallLogBadgeClass(level: NormalizedTrace.LogLevel | undefined, selected: boolean) {
  if (selected) return "border-primary/40 bg-primary/20 text-blue-100";
  if (level === "error") return "border-destructive/35 bg-destructive/15 text-red-200";
  if (level === "warning") return "border-amber-500/35 bg-amber-500/15 text-amber-200";
  return "border-border bg-muted/60 text-muted-foreground";
}

function WaterfallLogBadge({
  count,
  level,
  selected,
}: {
  count: number;
  level?: NormalizedTrace.LogLevel;
  selected: boolean;
}) {
  const isIssueLevel = level === "warning" || level === "error";
  const label = level === "error" ? "Error" : level === "warning" ? "Warn" : "Logs";
  const title = `${count} log${count === 1 ? "" : "s"}${level ? ` - max ${level}` : ""}`;

  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 text-[11px] leading-none",
        getWaterfallLogBadgeClass(level, selected),
      )}
      title={title}
      aria-label={title}
    >
      {!isIssueLevel && <MessageSquare className="h-3 w-3" />}
      {isIssueLevel ? (
        <>
          <span className="tabular-nums font-semibold">{count}</span>
          <span>{label}</span>
        </>
      ) : (
        <>
          <span>{label}</span>
          <span
            className={cn(
              "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] tabular-nums",
              selected ? "bg-primary/35 text-blue-50" : "bg-muted text-muted-foreground",
            )}
          >
            {count}
          </span>
        </>
      )}
    </span>
  );
}

function formatDuration(duration: number | undefined) {
  if (duration == null) return "running";
  return formatElapsed(duration);
}

function formatRelativeTime(timestamp: number | undefined, t0: number) {
  if (timestamp == null) return "";
  return formatElapsed(timestamp - t0);
}

function formatElapsed(ms: number) {
  if (!Number.isFinite(ms)) return "";
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  if (abs < 1) return `${sign}${abs.toFixed(3)}ms`;
  if (abs < 1000) return `${sign}${abs.toFixed(0)}ms`;

  const totalSeconds = Math.floor(abs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${sign}${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${sign}${minutes}m ${seconds}s`;
  }
  if (seconds >= 10) {
    return `${sign}${seconds}s`;
  }
  return `${sign}${(abs / 1000).toFixed(2)}s`;
}

function compactJson(value: unknown) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildAttributePayload(span: NormalizedTrace.AggregatedSpan) {
  const detail = span.detail as (TraceEvent & { trace?: { attributes?: unknown } }) | undefined;
  return detail?.trace?.attributes ?? {};
}

/**
 * Top time axis: ticks and grid lines based on t0..t1.
 */
function TimelineHeader({
  t0,
  t1,
  timelineWidthPx,
  /** Continuation strip to the right (e.g. over JSON column) — same row as the time axis */
  extendRight = false,
}: {
  t0: number;
  t1: number;
  timelineWidthPx: number;
  extendRight?: boolean;
}) {
  const total = t1 - t0;
  if (total <= 0) return null;

  // Reasonable step: aim for ~8–12 ticks
  const rawStep = total / 10;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = normalized <= 1 ? magnitude : normalized <= 2 ? 2 * magnitude : 5 * magnitude;
  const ticks: number[] = [];
  let tick = Math.floor(t0 / step) * step;
  if (tick < t0) tick += step;
  while (tick <= t1) {
    ticks.push(tick);
    tick += step;
  }

  return (
    <div
      className="flex w-full min-w-0 border-b border-border bg-muted/30 text-xs text-muted-foreground"
      style={{ height: 28 }}
    >
      {/* Center label in the name column so it does not sit flush against 0ms on the timeline edge */}
      <div
        className="shrink-0 border-r border-border flex items-center justify-center px-2 bg-background"
        style={{ width: NAME_COLUMN_WIDTH }}
      >
        <span className="text-[10px] text-center">Time</span>
      </div>
      <div
        className="relative shrink-0 border-r border-border"
        style={{
          width: timelineWidthPx,
          minWidth: timelineWidthPx,
        }}
      >
        {ticks.map((t) => {
          const pct = ((t - t0) / total) * 100;
          return (
            <div
              key={t}
              className="absolute top-0 bottom-0 w-px bg-border"
              style={{ left: `${pct}%` }}
            />
          );
        })}
        {ticks.map((t) => {
          const pct = ((t - t0) / total) * 100;
          return (
            <span
              key={t}
              className="absolute top-0.5 text-[10px] tabular-nums"
              style={{ left: `${pct}%`, transform: "translateX(-50%)" }}
            >
              {(t - t0).toFixed(0)}ms
            </span>
          );
        })}
      </div>
      {extendRight ? <div className="flex-1 min-w-0 bg-muted/30" aria-hidden /> : null}
    </div>
  );
}

function SpanBar({ row, t0, t1 }: { row: WaterfallRow; t0: number; t1: number }) {
  const { span } = row;
  const duration = span.duration ?? 0;
  const total = t1 - t0;
  const leftPct = total > 0 ? ((span.timestamp - t0) / total) * 100 : 0;
  const widthPct = total > 0 ? (duration / total) * 100 : 0;
  const isRunning = span.status === "running" && span.duration == null;
  const showDuration = !isRunning && duration >= 0 && widthPct >= 8;

  return (
    <div
      className="absolute top-0 h-full flex items-center pointer-events-none"
      style={{
        left: `${leftPct}%`,
        width: isRunning ? `max(2px, ${Math.max(0.5, widthPct)}%)` : `${Math.max(0.5, widthPct)}%`,
        minWidth: isRunning ? 4 : 2,
      }}
    >
      <div
        className={cn(
          "h-[14px] rounded-sm w-full min-w-[2px] flex items-center justify-center overflow-hidden",
          span.status === "error" && "bg-destructive/80",
          span.status === "success" && "bg-primary/70",
          span.status === "running" && "bg-primary/50",
        )}
        title={`${span.name} · ${duration.toFixed(0)}ms`}
      >
        {showDuration && (
          <span className="text-[10px] text-white/95 font-medium truncate px-1">
            {duration.toFixed(0)}ms
          </span>
        )}
      </div>
    </div>
  );
}

function DetailTabButton({
  value,
  activeTab,
  onSelect,
  children,
  count,
}: {
  value: WaterfallDetailTab;
  activeTab: WaterfallDetailTab;
  onSelect: (tab: WaterfallDetailTab) => void;
  children: ReactNode;
  count?: number;
}) {
  const isActive = activeTab === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={cn(
        "h-9 px-3 text-xs border-b-2 transition-colors flex items-center gap-1.5",
        isActive
          ? "border-primary text-foreground bg-muted/40"
          : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/20",
      )}
    >
      {children}
      {count != null && (
        <span
          className={cn(
            "inline-flex min-w-5 h-5 items-center justify-center rounded-full px-1.5 text-[10px] tabular-nums",
            isActive ? "bg-primary/25 text-blue-100" : "bg-muted text-muted-foreground",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function EmptyDetailMessage({ children }: { children: ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center text-muted-foreground text-sm px-3 text-center">
      {children}
    </div>
  );
}

function LogList({
  logs,
  t0,
  span,
}: {
  logs: TraceEvent[];
  t0: number;
  span: NormalizedTrace.AggregatedSpan;
}) {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<"all" | NormalizedTrace.LogLevel>("all");
  const [expandedLogKeys, setExpandedLogKeys] = useState<Set<string>>(new Set());
  const filteredLogs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return logs.filter((event) => {
      if (!isSysLogEvent(event)) return false;
      if (level !== "all" && event.level !== level) return false;
      if (!normalizedQuery) return true;
      return compactJson(event).toLowerCase().includes(normalizedQuery);
    });
  }, [logs, query, level]);

  const counts = useMemo(() => {
    const next: Record<NormalizedTrace.LogLevel, number> = {
      debug: 0,
      info: 0,
      warning: 0,
      error: 0,
    };
    for (const log of logs) {
      if (isSysLogEvent(log)) next[log.level] += 1;
    }
    return next;
  }, [logs]);

  const exportLogs = () => {
    const blob = new Blob([filteredLogs.map((event) => JSON.stringify(event)).join("\n")], {
      type: "application/x-ndjson",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `span-${span.id}-logs.jsonl`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const getLogKey = (event: TraceEvent, index: number) => {
    const payload = event as unknown as { _seq?: number; message?: string; level?: string };
    return [
      payload._seq ?? index,
      event.timestamp,
      event.trace?.spanId ?? "",
      event.type,
      payload.level ?? "",
      payload.message ?? "",
      compactJson((event as unknown as { args?: unknown }).args),
    ].join("|");
  };

  const toggleLogExpanded = (key: string) => {
    setExpandedLogKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (logs.length === 0) {
    return (
      <EmptyDetailMessage>
        {span.logCount
          ? `${span.logCount} log summary entries, but no raw log events saved.`
          : "No logs on this span"}
      </EmptyDetailMessage>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex-shrink-0 p-2 border-b border-border flex items-center gap-2">
        <label className="relative flex-1 min-w-0">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search logs..."
            className="h-8 w-full rounded border border-border bg-background pl-7 pr-2 text-xs outline-none focus:border-primary"
          />
        </label>
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value as "all" | NormalizedTrace.LogLevel)}
          className="h-8 rounded border border-border bg-background px-2 text-xs text-muted-foreground outline-none focus:border-primary"
          title="Filter by level"
        >
          {LOG_LEVELS.map((item) => (
            <option key={item} value={item}>
              {item === "all" ? "Level: All" : `${item} (${counts[item]})`}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={exportLogs}
          className="h-8 px-2 rounded border border-border bg-background text-xs text-muted-foreground hover:text-foreground hover:bg-muted flex items-center gap-1.5"
          title="Export visible logs"
        >
          <Download className="w-3.5 h-3.5" />
          Export
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-2 space-y-2">
        {filteredLogs.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
            No logs match the current filter
          </div>
        ) : (
          filteredLogs.map((event, index) => {
            if (!isSysLogEvent(event)) return null;
            const logKey = getLogKey(event, index);
            const isExpanded = expandedLogKeys.has(logKey);
            const firstArg =
              Array.isArray(event.args) && event.args.length > 0
                ? (event.args[0] as Record<string, unknown>)
                : undefined;
            const detailTags = firstArg
              ? Object.entries(firstArg)
                  .filter(([, value]) => value == null || typeof value !== "object")
                  .slice(0, 4)
              : [];

            return (
              <div
                key={logKey}
                className="rounded border border-border bg-muted/20 overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => toggleLogExpanded(logKey)}
                  className="w-full p-3 grid grid-cols-[96px_minmax(0,1fr)_auto] gap-2 items-start text-left hover:bg-muted/30 transition-colors"
                  aria-expanded={isExpanded}
                >
                  <div className="text-[11px] text-muted-foreground tabular-nums leading-5">
                    <div>{new Date(event.timestamp).toLocaleTimeString()}</div>
                    <div>{formatRelativeTime(event.timestamp, t0)}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={cn(
                          "inline-flex h-5 items-center rounded border px-1.5 text-[10px] font-semibold uppercase",
                          getLevelClass(event.level),
                        )}
                      >
                        {event.level === "warning" ? "warn" : event.level}
                      </span>
                      <span className="min-w-0 break-words text-xs leading-5 text-foreground">
                        {event.message}
                      </span>
                    </div>
                    {detailTags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {detailTags.map(([key, value]) => (
                          <span
                            key={key}
                            className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          >
                            {key}: {String(value)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <ChevronDown
                    className={cn(
                      "w-3.5 h-3.5 text-muted-foreground mt-1 transition-transform",
                      isExpanded && "rotate-180",
                    )}
                  />
                </button>
                {isExpanded && event.args && event.args.length > 0 && (
                  <div className="h-72 border-t border-border bg-background">
                    <JsonViewer data={event.args} />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * Right column: span inspector. Start/end payloads still come from `span.detail`; sys logs are displayed from saved log events.
 */
function WaterfallSpanDetailPanel({
  onHideDetail,
  activeTab,
  onTabChange,
  t0,
}: {
  onHideDetail: () => void;
  activeTab: WaterfallDetailTab;
  onTabChange: (tab: WaterfallDetailTab) => void;
  t0: number;
}) {
  const normalizedTrace = useTraceStore((s) => s.normalizedTrace);
  const activeNodeId = useSelectionStore((s) => s.activeNodeId);

  const span =
    activeNodeId && normalizedTrace?.waterfall?.aggregatedSpans
      ? normalizedTrace.waterfall.aggregatedSpans.get(activeNodeId)
      : undefined;

  const node = activeNodeId ? normalizedTrace?.nodeMap[activeNodeId] : undefined;
  const eventPayload = span?.detail;
  const logEvents = useMemo(() => collectLogEvents(span, node), [span, node]);
  const displayLogCount = logEvents.length > 0 ? logEvents.length : (span?.logCount ?? 0);
  const statusLabel = span?.status ?? node?.status;
  const hasError = Boolean(span?.error || (eventPayload as { error?: unknown } | undefined)?.error);

  return (
    <div className="relative h-full flex flex-col min-h-0 min-w-0 bg-background border-l border-border">
      {activeNodeId && (
        <button
          type="button"
          onClick={onHideDetail}
          className="absolute top-4 right-3 z-10 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          title="Hide detail panel"
          aria-label="Hide detail panel"
        >
          <X className="w-4 h-4" />
        </button>
      )}
      {!normalizedTrace ? (
        <EmptyDetailMessage>No trace loaded</EmptyDetailMessage>
      ) : !activeNodeId ? (
        <EmptyDetailMessage>Select a span to view details</EmptyDetailMessage>
      ) : !span ? (
        <EmptyDetailMessage>No aggregated span for this id</EmptyDetailMessage>
      ) : (
        <>
          <div className="flex-shrink-0 px-3 py-3 border-b border-border pr-10">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="truncate text-sm font-semibold text-foreground">
                {span.name}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  ({span.type})
                </span>
              </h2>
            </div>
            <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs",
                  statusLabel === "error" && "bg-destructive/20 text-red-200",
                  statusLabel === "success" && "bg-emerald-500/20 text-emerald-200",
                  statusLabel === "running" && "bg-blue-500/20 text-blue-100",
                )}
              >
                {statusLabel}
              </span>
              <span className="tabular-nums">from {formatRelativeTime(span.timestamp, t0)}</span>
              <span className="tabular-nums">
                to{" "}
                {span.duration != null
                  ? formatRelativeTime(span.timestamp + span.duration, t0)
                  : "running"}
              </span>
              <span className="tabular-nums">dur {formatDuration(span.duration)}</span>
            </div>
          </div>

          <div className="flex-shrink-0 border-b border-border flex items-end overflow-x-auto">
            <DetailTabButton value="overview" activeTab={activeTab} onSelect={onTabChange}>
              Overview
            </DetailTabButton>
            <DetailTabButton value="attributes" activeTab={activeTab} onSelect={onTabChange}>
              Attributes
            </DetailTabButton>
            <DetailTabButton
              value="logs"
              activeTab={activeTab}
              onSelect={onTabChange}
              count={displayLogCount}
            >
              Logs
            </DetailTabButton>
            <DetailTabButton
              value="error"
              activeTab={activeTab}
              onSelect={onTabChange}
              count={hasError ? 1 : 0}
            >
              Error
            </DetailTabButton>
          </div>

          <div className="flex-1 min-h-0">
            {activeTab === "overview" &&
              (eventPayload ? (
                <JsonViewer data={eventPayload} />
              ) : (
                <EmptyDetailMessage>No event payload on this span</EmptyDetailMessage>
              ))}
            {activeTab === "attributes" && <JsonViewer data={buildAttributePayload(span)} />}
            {activeTab === "logs" && <LogList logs={logEvents} t0={t0} span={span} />}
            {activeTab === "error" &&
              (hasError ? (
                <JsonViewer data={span.error ?? (eventPayload as { error?: unknown }).error} />
              ) : (
                <EmptyDetailMessage>No error recorded on this span</EmptyDetailMessage>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

export function Waterfall() {
  const normalizedTrace = useTraceStore((s) => s.normalizedTrace);
  const setActiveNode = useSelectionStore((s) => s.setActiveNode);
  const activeNodeId = useSelectionStore((s) => s.activeNodeId);
  const { toast } = useToast();

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast({ title: "Copied", description: `${label} copied to clipboard` }),
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  };

  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [zoomLevel, setZoomLevel] = useState(1);
  const [activeDetailTab, setActiveDetailTab] = useState<WaterfallDetailTab>("overview");
  /** Left scroll body (name + bars only) — drives timeline width; shared header row sits above PanelGroup. */
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const detailPanelRef = useRef<ImperativePanelHandle>(null);
  const [viewportWidth, setViewportWidth] = useState(0);

  // Keep panel in sync with selection: no selection -> collapsed; selection while collapsed -> expand
  useEffect(() => {
    const panel = detailPanelRef.current;
    if (!panel) return;

    if (activeNodeId) {
      if (panel.getSize() === 0) {
        panel.expand();
      }
    } else {
      panel.collapse();
    }
  }, [activeNodeId]);

  useLayoutEffect(() => {
    const el = leftScrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewportWidth(el.clientWidth);
    });
    ro.observe(el);
    setViewportWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const { rows, t0, t1 } = useMemo(() => {
    if (!normalizedTrace?.waterfall) return { rows: [] as WaterfallRow[], t0: 0, t1: 1 };
    return flattenSpanTree(normalizedTrace.waterfall, collapsedIds);
  }, [normalizedTrace?.waterfall, collapsedIds]);

  const totalDuration = t1 - t0;
  /** Timeline width scales with visible viewport so the right-side JSON panel triggers reflow + X-axis rescale. */
  const availableForTimeline = Math.max(0, viewportWidth - NAME_COLUMN_WIDTH);
  const timelineWidthPx =
    viewportWidth > 0
      ? Math.max(200, Math.round(availableForTimeline * zoomLevel))
      : Math.round(TIMELINE_BASE_WIDTH * zoomLevel);

  const toggleCollapse = (spanId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(spanId)) next.delete(spanId);
      else next.add(spanId);
      return next;
    });
  };

  const handleRowClick = (
    spanId: string,
    type: string,
    nextTab: WaterfallDetailTab = "overview",
  ) => {
    const detailType: DetailNodeType =
      type === "agent" || type === "span" || type === "runWith" ? type : "span";
    setActiveNode(spanId, detailType);
    setActiveDetailTab(nextTab);
    detailPanelRef.current?.expand();
  };

  if (!normalizedTrace) {
    return (
      <div className="h-full w-full flex items-center justify-center text-muted-foreground text-sm">
        No trace loaded
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="h-full w-full flex items-center justify-center text-muted-foreground text-sm">
        No spans in trace
      </div>
    );
  }

  return (
    <div className="h-full w-full min-w-0 flex flex-col bg-background">
      <div className="flex-shrink-0 px-3 py-2 border-b border-border flex items-center justify-between gap-4 text-xs text-muted-foreground flex-wrap">
        <div className="flex items-center gap-5 flex-wrap">
          <span className="text-muted-foreground/80">
            {rows.length} spans · {totalDuration.toFixed(0)}ms total
          </span>
          <CopyableId
            label="traceId"
            value={normalizedTrace.id}
            onCopy={(v) => copyToClipboard(v, "traceId")}
          />
          {activeNodeId && (
            <CopyableId
              label="spanId"
              value={activeNodeId}
              onCopy={(v) => copyToClipboard(v, "spanId")}
            />
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground/80">Zoom</span>
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            value={zoomLevel}
            onChange={(e) => setZoomLevel(Number(e.target.value))}
            className="w-24 h-1.5 accent-primary"
          />
          <span className="tabular-nums w-8">{zoomLevel}x</span>
          <AskAIButton />
        </div>
      </div>

      <div className="flex-shrink-0 w-full min-w-0">
        <TimelineHeader t0={t0} t1={t1} timelineWidthPx={timelineWidthPx} extendRight />
      </div>

      <PanelGroup direction="horizontal" className="flex-1 min-h-0 min-w-0">
        <Panel defaultSize={68} minSize={45} className="min-w-0 flex flex-col">
          <div ref={leftScrollRef} className="flex-1 min-h-0 min-w-0 overflow-auto">
            <div
              className="min-w-0"
              style={{
                width: NAME_COLUMN_WIDTH + timelineWidthPx,
                minWidth: NAME_COLUMN_WIDTH + timelineWidthPx,
              }}
            >
              {rows.map((row) => {
                const { span } = row;
                const hasChildren = span.childrenIds.length > 0;
                const isCollapsed = collapsedIds.has(span.id);
                const isSelected = activeNodeId === span.id;
                const isError = span.status === "error";
                const node = normalizedTrace.nodeMap[span.id];
                const logEvents = collectLogEvents(span, node);
                const displayLogCount =
                  logEvents.length > 0 ? logEvents.length : (span.logCount ?? 0);
                const displayLogLevel = getMaxLogLevelFromEvents(logEvents) ?? span.maxLogLevel;

                return (
                  <div
                    key={span.id}
                    role="button"
                    tabIndex={0}
                    className={cn(
                      "flex border-b border-border hover:bg-muted/50 cursor-pointer",
                      isSelected && "bg-primary/10",
                    )}
                    style={{ height: ROW_HEIGHT }}
                    onClick={() => handleRowClick(span.id, span.type)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleRowClick(span.id, span.type);
                      }
                    }}
                  >
                    {/* Left: name column (sticky when horizontal scroll) */}
                    <div
                      className={cn(
                        "flex items-center gap-1 shrink-0 border-r border-border pr-2 bg-background sticky left-0 z-10",
                        isError && "text-destructive",
                      )}
                      style={{
                        width: NAME_COLUMN_WIDTH,
                        paddingLeft: DEPTH_INDENT * row.depth + 8,
                      }}
                      title={`${span.name} [${span.type}]`}
                    >
                      {hasChildren ? (
                        <button
                          type="button"
                          className="p-0.5 rounded hover:bg-muted shrink-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleCollapse(span.id);
                          }}
                          aria-label={isCollapsed ? "Expand" : "Collapse"}
                        >
                          <ChevronRight
                            className={cn(
                              "w-3.5 h-3.5 transition-transform",
                              !isCollapsed && "rotate-90",
                            )}
                          />
                        </button>
                      ) : (
                        <span style={{ width: 14 }} />
                      )}
                      {getSpanTypeIcon(span.type)}
                      {isError && <XCircle className="w-3 h-3 text-destructive shrink-0" />}
                      {displayLogCount > 0 ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRowClick(span.id, span.type, "logs");
                          }}
                          className="shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                          title="Open logs"
                        >
                          <WaterfallLogBadge
                            count={displayLogCount}
                            level={displayLogLevel}
                            selected={isSelected && activeDetailTab === "logs"}
                          />
                        </button>
                      ) : null}
                      <span className="truncate text-xs">{span.name}</span>
                    </div>

                    {/* Right: timeline bar */}
                    <div
                      className="relative flex-1 min-w-0"
                      style={{
                        width: timelineWidthPx,
                        minWidth: timelineWidthPx,
                      }}
                    >
                      <SpanBar row={row} t0={t0} t1={t1} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className="w-1 bg-border hover:bg-resize-handle-hover transition-colors cursor-col-resize" />
        <Panel
          ref={detailPanelRef}
          collapsible
          collapsedSize={0}
          defaultSize={32}
          minSize={18}
          maxSize={55}
          className={cn("min-w-0 flex flex-col", activeNodeId && "border-l border-border")}
        >
          <WaterfallSpanDetailPanel
            activeTab={activeDetailTab}
            onTabChange={setActiveDetailTab}
            t0={t0}
            onHideDetail={() => {
              detailPanelRef.current?.collapse();
              setActiveNode(null, null);
            }}
          />
        </Panel>
      </PanelGroup>
    </div>
  );
}
