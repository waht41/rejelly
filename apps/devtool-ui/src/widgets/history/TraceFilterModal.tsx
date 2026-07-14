import {
  fetchTraceSummary,
  generateTraceFilter,
  type TraceFilterChatMessage,
  type TraceFilterGenerateResponse,
  type TraceFilterNode,
  type TraceFilterOp,
  type TraceFilterRequest,
  type TraceFilterValue,
  type TraceSummaryResponse,
} from "@entities/trace/api";
import {
  getTraceTimePreset,
  hasEffectiveTraceFilter,
  type TraceTimePreset,
} from "@entities/trace/lib/traceFilterRequest";
import * as DialogPrimitives from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, Settings, Sparkles, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { SavedTraceFilter } from "./useTraceHistoryFilterStore";

type TraceFilterModalProps = {
  currentTraceId: string | null;
  activeFilter: SavedTraceFilter | null;
  onActiveFilterChange: (filter: SavedTraceFilter | null) => void;
};

type AiMessageTone = "info" | "warning" | "error";
type TimeRangeType = "preset" | "range";

const FILTER_STORAGE_KEY = "devtool.trace-history.filters";

function createFilterId() {
  return `filter-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function formatBrowserNowWithOffset(date = new Date()) {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;

  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    offset,
  ].join("");
}

function isFilterValue(value: unknown): value is TraceFilterValue {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function loadSavedFilters(): SavedTraceFilter[] {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedTraceFilter[]) : [];
  } catch {
    return [];
  }
}

function persistSavedFilters(filters: SavedTraceFilter[]) {
  localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
}

function formatFilterValue(value: TraceFilterValue) {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

const OP_SYMBOLS: Record<Exclude<TraceFilterOp, "exists">, string> = {
  eq: "==",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  contains: "contains",
};

function formatFilterNode(node: TraceFilterNode): string {
  switch (node.kind) {
    case "and":
      return `(${node.filters.map(formatFilterNode).join(" AND ")})`;
    case "or":
      return `(${node.filters.map(formatFilterNode).join(" OR ")})`;
    case "not":
      return `NOT ${formatFilterNode(node.filter)}`;
    case "builtin":
      if (node.op === "exists") {
        return `${node.key} exists`;
      }
      return `${node.key} ${OP_SYMBOLS[node.op]} ${formatFilterValue(node.value)}`;
    case "model_usage":
      if (node.op === "exists") {
        return `model[${JSON.stringify(node.model)}] exists`;
      }
      return `model[${JSON.stringify(node.model)}].${node.field} ${OP_SYMBOLS[node.op]} ${
        node.value
      }`;
    case "cost":
      if (node.op === "exists") {
        return `cost[${JSON.stringify(node.unit)}] exists`;
      }
      return `cost[${JSON.stringify(node.unit)}] ${OP_SYMBOLS[node.op]} ${node.value}`;
    case "tool_execution":
      if (node.op === "exists") {
        return `tool[${JSON.stringify(node.tool)}] executed`;
      }
      return `tool[${JSON.stringify(node.tool)}].${node.field} ${OP_SYMBOLS[node.op]} ${
        node.value
      }`;
    case "root_attr":
      return node.op === "exists"
        ? `root[${JSON.stringify(node.key)}] exists`
        : `root[${JSON.stringify(node.key)}] ${OP_SYMBOLS[node.op]} ${formatFilterValue(
            node.value ?? null,
          )}`;
  }
}

function formatTimeRange(timeRange: TraceFilterRequest["timeRange"]) {
  const preset = timeRange?.preset ?? "7d";
  if (timeRange?.from || timeRange?.to) {
    return [
      ...(timeRange.from ? [`started_at >= ${timeRange.from}`] : []),
      ...(timeRange.to ? [`started_at < ${timeRange.to}`] : []),
    ];
  }
  return [`started_at >= now - ${preset}`];
}

function formatFilterRequest(request: TraceFilterRequest | null) {
  const timeLines = formatTimeRange(request?.timeRange);
  if (!request || request.filters.length === 0) return timeLines.join("\nAND ");
  return [...timeLines, ...request.filters.map(formatFilterNode)].join("\nAND ");
}

function getPrimitiveAttributes(trace?: TraceSummaryResponse) {
  const attrs = trace?.attributes ?? {};
  return Object.entries(attrs)
    .filter((entry): entry is [string, TraceFilterValue] => isFilterValue(entry[1]))
    .sort(([a], [b]) => a.localeCompare(b));
}

function isEqNode(node: TraceFilterNode, key: string, value: TraceFilterValue) {
  return node.kind === "root_attr" && node.op === "eq" && node.key === key && node.value === value;
}

function toneForFilterStatus(status: TraceFilterGenerateResponse["status"]): AiMessageTone {
  switch (status) {
    case "ok":
    case "clarification":
      return "info";
    case "unsupported_field":
      return "warning";
    case "out_of_scope":
      return "error";
  }
  return "info";
}

function fallbackFilterStatusMessage(status: TraceFilterGenerateResponse["status"]) {
  switch (status) {
    case "ok":
      return "Filter updated.";
    case "clarification":
      return "Please clarify the request.";
    case "unsupported_field":
      return "That field is not currently queryable. Current draft unchanged.";
    case "out_of_scope":
      return "This endpoint only creates trace search filters. Current draft unchanged.";
  }
  return "Current draft unchanged.";
}

function formatNonOkFilterMessage(response: TraceFilterGenerateResponse) {
  const message = response.message ?? fallbackFilterStatusMessage(response.status);
  return message.includes("Current draft unchanged")
    ? message
    : `${message} Current draft unchanged.`;
}

function buildTimeRange(
  type: TimeRangeType,
  preset: TraceTimePreset,
  from: string | null,
  to: string | null,
): NonNullable<TraceFilterRequest["timeRange"]> {
  if (type === "range") {
    return {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    };
  }
  return {
    preset,
  };
}

function getTraceTimeRangeType(request?: TraceFilterRequest | null): TimeRangeType {
  return request?.timeRange?.from || request?.timeRange?.to ? "range" : "preset";
}

export function TraceFilterModal({
  currentTraceId,
  activeFilter,
  onActiveFilterChange,
}: TraceFilterModalProps) {
  const [open, setOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState<TraceFilterNode[]>([]);
  const [timeRangeType, setTimeRangeType] = useState<TimeRangeType>("preset");
  const [timePreset, setTimePreset] = useState<TraceTimePreset>("7d");
  const [timeFrom, setTimeFrom] = useState<string | null>(null);
  const [timeTo, setTimeTo] = useState<string | null>(null);
  const [savedFilters, setSavedFilters] = useState<SavedTraceFilter[]>(loadSavedFilters);
  const [filterName, setFilterName] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiMessage, setAiMessage] = useState<{ tone: AiMessageTone; text: string } | null>(null);
  const [aiHistory, setAiHistory] = useState<TraceFilterChatMessage[]>([]);
  const hydratedActiveFilterIdRef = useRef<string | null>(null);

  const { data: currentTraceDetail } = useQuery({
    queryKey: ["trace-history-filter-attrs", currentTraceId],
    queryFn: () => fetchTraceSummary(currentTraceId!),
    enabled: open && !!currentTraceId,
  });

  const currentAttributes = useMemo(
    () => getPrimitiveAttributes(currentTraceDetail),
    [currentTraceDetail],
  );

  const draftRequest: TraceFilterRequest = useMemo(
    () => ({
      timeRange: buildTimeRange(timeRangeType, timePreset, timeFrom, timeTo),
      filters: draftFilters,
      limit: 50,
    }),
    [timeRangeType, timePreset, timeFrom, timeTo, draftFilters],
  );
  const hasDraftFilter = hasEffectiveTraceFilter(draftRequest);

  const updateSavedFilters = (next: SavedTraceFilter[]) => {
    setSavedFilters(next);
    persistSavedFilters(next);
  };

  const toggleAttrFilter = (key: string, value: TraceFilterValue) => {
    setDraftFilters((prev) => {
      if (prev.some((node) => isEqNode(node, key, value))) {
        return prev.filter((node) => !isEqNode(node, key, value));
      }
      return [...prev, { kind: "root_attr", key, op: "eq", value }];
    });
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen && activeFilter && activeFilter.id !== hydratedActiveFilterIdRef.current) {
      setDraftFilters(activeFilter.request.filters);
      setTimeRangeType(getTraceTimeRangeType(activeFilter.request));
      setTimePreset(getTraceTimePreset(activeFilter.request));
      setTimeFrom(activeFilter.request.timeRange?.from ?? null);
      setTimeTo(activeFilter.request.timeRange?.to ?? null);
      hydratedActiveFilterIdRef.current = activeFilter.id;
    } else if (nextOpen && !activeFilter) {
      hydratedActiveFilterIdRef.current = null;
    }
    setOpen(nextOpen);
  };

  const submitAiPrompt = async () => {
    const prompt = aiPrompt.trim();
    if (!prompt || aiLoading) return;

    setAiLoading(true);
    setAiMessage(null);
    try {
      const response = await generateTraceFilter(prompt, aiHistory, {
        traceId: currentTraceId,
        currentRequest: draftRequest,
        now: formatBrowserNowWithOffset(),
      });
      // delta carries only assistant messages; the user turn is appended client-side
      setAiHistory((prev) => [
        ...prev,
        { role: "user", content: prompt },
        ...(response.delta ?? []),
      ]);
      if (response.status === "ok") {
        setDraftFilters(response.filters ?? []);
        if (response.time_range?.type === "preset") {
          setTimeRangeType("preset");
          setTimePreset(response.time_range.preset);
          setTimeFrom(null);
          setTimeTo(null);
        } else if (response.time_range?.type === "range") {
          setTimeRangeType("range");
          setTimeFrom(response.time_range.from ?? null);
          setTimeTo(response.time_range.to ?? null);
        } else {
          if (timeRangeType === "preset") {
            setTimeFrom(null);
            setTimeTo(null);
          }
        }
        setAiPrompt("");
        if (response.message) {
          setAiMessage({ tone: "info", text: response.message });
        }
      } else {
        setAiMessage({
          tone: toneForFilterStatus(response.status),
          text: formatNonOkFilterMessage(response),
        });
      }
    } catch (err) {
      setAiMessage({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setAiLoading(false);
    }
  };

  const applyDraftFilter = () => {
    if (!hasDraftFilter) return;

    onActiveFilterChange({
      id: "__draft__",
      name: "Custom",
      request: draftRequest,
    });
    setOpen(false);
  };

  const saveDraftFilter = () => {
    if (!hasDraftFilter) return;

    const name = filterName.trim() || `Filter ${savedFilters.length + 1}`;
    const saved = {
      id: createFilterId(),
      name,
      request: draftRequest,
    };
    updateSavedFilters([saved, ...savedFilters]);
    onActiveFilterChange(saved);
    setFilterName("");
    setOpen(false);
  };

  const renameSavedFilter = (id: string, name: string) => {
    updateSavedFilters(
      savedFilters.map((filter) => (filter.id === id ? { ...filter, name } : filter)),
    );
  };

  const updateSavedFilterRequest = (id: string) => {
    const nextFilters = savedFilters.map((filter) =>
      filter.id === id
        ? {
            ...filter,
            request: draftRequest,
          }
        : filter,
    );
    updateSavedFilters(nextFilters);
    const updated = nextFilters.find((filter) => filter.id === id);
    if (updated) onActiveFilterChange(updated);
  };

  const deleteSavedFilter = (id: string) => {
    updateSavedFilters(savedFilters.filter((filter) => filter.id !== id));
    if (activeFilter?.id === id) onActiveFilterChange(null);
  };

  return (
    <DialogPrimitives.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitives.Trigger asChild>
        <button
          type="button"
          className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Trace filters"
        >
          <Settings className="h-4 w-4" />
        </button>
      </DialogPrimitives.Trigger>
      <DialogPrimitives.Portal>
        <DialogPrimitives.Overlay className="fixed inset-0 z-50 bg-black/35" />
        <DialogPrimitives.Content className="fixed left-1/2 top-1/2 z-50 h-[min(720px,calc(100vh-32px))] w-[min(820px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-md border border-border bg-background shadow-xl outline-none flex flex-col">
          <div className="h-12 shrink-0 border-b border-border px-4 flex items-center justify-between">
            <div>
              <DialogPrimitives.Title className="text-sm font-semibold">
                Trace Filters
              </DialogPrimitives.Title>
              <DialogPrimitives.Description className="sr-only">
                Build structured trace filters from root attributes.
              </DialogPrimitives.Description>
            </div>
            <DialogPrimitives.Close className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
              <X className="h-4 w-4" />
            </DialogPrimitives.Close>
          </div>

          <div className="shrink-0 border-b border-border px-4 py-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold">Time Range</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                Search traces with started_at inside this range.
              </div>
            </div>
            <div className="inline-flex rounded-md border border-border p-0.5">
              {(["1h", "24h", "7d", "30d"] as const).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={[
                    "px-2.5 py-1 text-xs rounded-sm",
                    timeRangeType === "preset" && timePreset === preset
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  ].join(" ")}
                  onClick={() => {
                    setTimeRangeType("preset");
                    setTimePreset(preset);
                    setTimeFrom(null);
                    setTimeTo(null);
                  }}
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-[1fr_1fr] gap-0 overflow-hidden">
            <div className="min-h-0 border-r border-border flex flex-col">
              <div className="px-4 py-3 border-b border-border">
                <div className="text-xs font-semibold">Current Trace Root Attributes</div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  Click to append an exact-match condition.
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-2">
                {currentAttributes.length === 0 ? (
                  <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                    No primitive root attributes on the current trace.
                  </div>
                ) : (
                  currentAttributes.map(([key, value]) => {
                    const selected = draftFilters.some((node) => isEqNode(node, key, value));
                    return (
                      <button
                        key={`${key}:${String(value)}`}
                        type="button"
                        className={[
                          "w-full rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted flex items-start gap-2",
                          selected ? "bg-primary/10 text-foreground" : "",
                        ].join(" ")}
                        onClick={() => toggleAttrFilter(key, value)}
                      >
                        <span className="mt-0.5 h-3.5 w-3.5 shrink-0 inline-flex items-center justify-center">
                          {selected && <Check className="h-3.5 w-3.5 text-primary" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono">{key}</span>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {formatFilterValue(value)}
                          </span>
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            <div className="min-h-0 flex flex-col">
              <div className="shrink-0 px-4 py-3 border-b border-border">
                <div className="relative">
                  <input
                    value={aiPrompt}
                    onChange={(event) => setAiPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void submitAiPrompt();
                      }
                    }}
                    placeholder="Describe a filter... (e.g. failed traces over 10s)"
                    disabled={aiLoading}
                    className="w-full rounded-sm border border-border bg-background py-1.5 pl-2 pr-8 text-xs outline-none focus:border-primary/70 disabled:opacity-60"
                  />
                  <button
                    type="button"
                    onClick={() => void submitAiPrompt()}
                    disabled={!aiPrompt.trim() || aiLoading}
                    aria-label="Generate filter"
                    title="Generate filter with AI"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 inline-flex items-center justify-center rounded-sm text-primary hover:bg-primary/10 disabled:text-muted-foreground disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    {aiLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
                {aiMessage && (
                  <div
                    className={[
                      "mt-1.5 text-[11px] leading-relaxed",
                      aiMessage.tone === "error"
                        ? "text-destructive"
                        : aiMessage.tone === "warning"
                          ? "text-amber-400"
                          : "text-muted-foreground",
                    ].join(" ")}
                  >
                    {aiMessage.text}
                  </div>
                )}
                <div className="mt-2 text-xs font-semibold">Current Draft</div>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-muted/40 p-2 text-[11px] leading-relaxed text-muted-foreground">
                  {formatFilterRequest(draftRequest)}
                </pre>
              </div>

              <div className="min-h-0 flex-1 overflow-auto p-3">
                <div>
                  <div className="mb-1 text-[11px] font-semibold text-muted-foreground uppercase">
                    Saved Filters
                  </div>
                  {savedFilters.length === 0 ? (
                    <div className="text-xs text-muted-foreground">No saved filters</div>
                  ) : (
                    <div className="space-y-1">
                      {savedFilters.map((filter) => (
                        <div
                          key={filter.id}
                          className="flex items-center gap-1 rounded-sm border border-border p-1"
                        >
                          <input
                            value={filter.name}
                            onChange={(event) => renameSavedFilter(filter.id, event.target.value)}
                            className="min-w-0 flex-1 bg-transparent px-1 text-xs outline-none"
                          />
                          <button
                            type="button"
                            className="shrink-0 rounded-sm px-2 py-1 text-xs hover:bg-muted"
                            disabled={!hasDraftFilter}
                            onClick={() => updateSavedFilterRequest(filter.id)}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="shrink-0 rounded-sm px-2 py-1 text-xs hover:bg-muted"
                            onClick={() => {
                              onActiveFilterChange(filter);
                              setDraftFilters(filter.request.filters);
                              setTimeRangeType(getTraceTimeRangeType(filter.request));
                              setTimePreset(getTraceTimePreset(filter.request));
                              setTimeFrom(filter.request.timeRange?.from ?? null);
                              setTimeTo(filter.request.timeRange?.to ?? null);
                              setOpen(false);
                            }}
                          >
                            Apply
                          </button>
                          <button
                            type="button"
                            className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                            onClick={() => deleteSavedFilter(filter.id)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="shrink-0 border-t border-border p-3 flex items-center gap-2 bg-background">
                <input
                  value={filterName}
                  onChange={(event) => setFilterName(event.target.value)}
                  placeholder="Filter name"
                  className="min-w-0 flex-1 rounded-sm border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary/70"
                />
                <button
                  type="button"
                  disabled={!hasDraftFilter}
                  className="shrink-0 rounded-sm border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-40"
                  onClick={saveDraftFilter}
                >
                  Save
                </button>
                <button
                  type="button"
                  disabled={!hasDraftFilter}
                  className="shrink-0 rounded-sm bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-40"
                  onClick={applyDraftFilter}
                >
                  Apply
                </button>
              </div>
            </div>
          </div>
        </DialogPrimitives.Content>
      </DialogPrimitives.Portal>
    </DialogPrimitives.Root>
  );
}
