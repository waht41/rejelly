/**
 * Trace History Component
 *
 * Displays recent traces (sorted by time) and starred traces.
 * Different from header's recent trace which is sorted by view order.
 * List data: useTraceList (server recent/starred). Imported file traces are
 * regular server traces, marked with the "imported" tag badge.
 */

import { useTraceList } from "@entities/trace/hooks/useTraceList";
import { getTraceDisplayNameOrUntitled } from "@entities/trace/lib/traceDisplayName";
import { useTraceStore } from "@entities/trace/store";
import { IMPORTED_TRACE_TAG } from "@features/load-trace/lib/traceFile";
import { useSelectTrace } from "@features/select/useSelectTrace";
import { formatTimeAgo } from "@shared/lib/formatters";
import { cn } from "@shared/lib/style";
import { SlidersHorizontal, Star, X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { TraceFilterModal } from "./TraceFilterModal";
import { useTraceHistoryFilterStore } from "./useTraceHistoryFilterStore";

type TraceHistoryProps = {
  /** Called after user selects a trace (e.g. close drawer) */
  onAfterSelect?: () => void;
};

/** True when a trace summary's tags JSON contains the imported marker. */
function isImported(tags?: string | null): boolean {
  if (!tags) return false;
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) && parsed.includes(IMPORTED_TRACE_TAG);
  } catch {
    return false;
  }
}

export function TraceHistory({ onAfterSelect }: TraceHistoryProps = {}) {
  const { selectTrace } = useSelectTrace();
  const currentTraceId = useTraceStore((state) => state.currentTraceId);
  const activeFilter = useTraceHistoryFilterStore((state) => state.activeFilter);
  const setActiveFilter = useTraceHistoryFilterStore((state) => state.setActiveFilter);
  const activeRequest = activeFilter?.request ?? null;
  const {
    recentTraces,
    starredTraces,
    isLoading: loading,
    error,
    hasMoreRecentTraces,
    isFetchingMoreRecentTraces,
    fetchMoreRecentTraces,
  } = useTraceList(activeRequest);
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const handleTraceClick = useCallback(
    (traceId: string) => {
      selectTrace(traceId);
      onAfterSelect?.();
    },
    [selectTrace, onAfterSelect],
  );

  useEffect(() => {
    const root = scrollRootRef.current;
    const target = loadMoreRef.current;
    if (!root || !target || !hasMoreRecentTraces) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingMoreRecentTraces) {
          void fetchMoreRecentTraces();
        }
      },
      { root, rootMargin: "160px" },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [fetchMoreRecentTraces, hasMoreRecentTraces, isFetchingMoreRecentTraces]);

  return (
    <div className="h-full w-full flex flex-col bg-background">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Trace History</h2>
          {activeFilter && (
            <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground min-w-0">
              <SlidersHorizontal className="h-3 w-3 shrink-0" />
              <span className="truncate">{activeFilter.name}</span>
              <button
                type="button"
                className="ml-1 hover:text-foreground"
                onClick={() => setActiveFilter(null)}
                title="Clear filter"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>

        <TraceFilterModal
          currentTraceId={currentTraceId}
          activeFilter={activeFilter}
          onActiveFilterChange={setActiveFilter}
        />
      </div>

      <div ref={scrollRootRef} className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-4 text-sm text-muted-foreground">Loading...</div>
        ) : error ? (
          <div className="p-4 text-sm text-destructive">{error.message}</div>
        ) : (
          <>
            {/* Starred Traces Section */}
            {starredTraces.length > 0 && (
              <div className="border-b border-border">
                <div className="px-3 py-2 bg-muted/30">
                  <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                    <Star className="w-3 h-3 fill-yellow-500 text-yellow-500" />
                    Starred ({starredTraces.length})
                  </div>
                </div>
                <div className="max-h-[300px] overflow-auto">
                  {starredTraces.map((trace) => (
                    <div
                      key={trace.traceId}
                      className={cn(
                        "group flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted rounded-sm transition-colors cursor-pointer",
                        trace.traceId === currentTraceId && "bg-muted",
                      )}
                      onClick={() => handleTraceClick(trace.traceId)}
                    >
                      <button
                        className={cn(
                          "flex items-center justify-between min-w-0 flex-1 text-left",
                          trace.traceId === currentTraceId && "font-semibold",
                        )}
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <Star className="w-3 h-3 fill-yellow-500 text-yellow-500 flex-shrink-0" />
                          <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-sm">
                            #{trace.traceId.slice(0, 8)}
                          </span>
                          <span className="truncate">{getTraceDisplayNameOrUntitled(trace)}</span>
                        </div>
                        <span className="text-[10px] text-muted-foreground ml-2 flex-shrink-0 tabular-nums">
                          {formatTimeAgo(trace.timestamp)}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Recent Traces Section */}
            <div>
              <div className="px-3 py-2 bg-muted/30">
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Recent ({recentTraces.length})
                </div>
              </div>
              <div>
                {recentTraces.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                    No traces found
                  </div>
                ) : (
                  recentTraces.map((trace) => (
                    <div
                      key={trace.traceId}
                      className={cn(
                        "group flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted rounded-sm transition-colors cursor-pointer",
                        trace.traceId === currentTraceId && "bg-muted",
                      )}
                      onClick={() => handleTraceClick(trace.traceId)}
                    >
                      <button
                        className={cn(
                          "flex items-center justify-between min-w-0 flex-1 text-left",
                          trace.traceId === currentTraceId && "font-semibold",
                        )}
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-sm">
                            #{trace.traceId.slice(0, 8)}
                          </span>
                          <span className="truncate">{getTraceDisplayNameOrUntitled(trace)}</span>
                          {isImported(trace.tags) && (
                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground bg-muted px-1.5 py-0.5 rounded-sm flex-shrink-0">
                              imported
                            </span>
                          )}
                          {trace.isStarred && (
                            <Star className="w-3 h-3 fill-yellow-500 text-yellow-500 flex-shrink-0" />
                          )}
                        </div>
                        <span className="text-[10px] text-muted-foreground ml-2 flex-shrink-0 tabular-nums">
                          {formatTimeAgo(trace.timestamp)}
                        </span>
                      </button>
                    </div>
                  ))
                )}
                {hasMoreRecentTraces && (
                  <div ref={loadMoreRef} className="px-3 py-3">
                    <button
                      type="button"
                      className="w-full rounded-sm border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isFetchingMoreRecentTraces}
                      onClick={() => void fetchMoreRecentTraces()}
                    >
                      {isFetchingMoreRecentTraces ? "Loading..." : "Load more"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
