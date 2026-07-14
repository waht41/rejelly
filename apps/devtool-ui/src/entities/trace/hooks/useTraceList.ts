/**
 * Trace List Hook
 *
 * Encapsulates server-side trace list fetching (recent + starred).
 * Uses useQuery so all consumers share the same cache and stay in sync.
 * combine() centralizes result mapping so order is defined in one place;
 * if you add queries, append to queries and update combine indices to match.
 */

import {
  fetchTraces,
  searchTraces,
  type TraceFilterRequest,
  type TraceSummaryResponse,
} from "@entities/trace/api";
import { hasEffectiveTraceFilter } from "@entities/trace/lib/traceFilterRequest";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

const RECENT_QUERY_KEY = ["traces", "recent"] as const;
const STARRED_QUERY_KEY = ["traces", "starred"] as const;
const TRACE_HISTORY_PAGE_SIZE = 50;

export function useTraceList(filterRequest?: TraceFilterRequest | null) {
  const activeFilterRequest = hasEffectiveTraceFilter(filterRequest) ? filterRequest : null;

  const recent = useInfiniteQuery({
    queryKey: activeFilterRequest
      ? [...RECENT_QUERY_KEY, "filtered", activeFilterRequest]
      : RECENT_QUERY_KEY,
    initialPageParam: activeFilterRequest ? null : 1,
    queryFn: ({ pageParam, signal }) =>
      activeFilterRequest
        ? searchTraces(
            {
              ...activeFilterRequest,
              limit: activeFilterRequest.limit ?? TRACE_HISTORY_PAGE_SIZE,
              cursor: typeof pageParam === "string" ? pageParam : undefined,
            },
            signal,
          )
        : fetchTraces({
            pageSize: TRACE_HISTORY_PAGE_SIZE,
            page: typeof pageParam === "number" ? pageParam : 1,
            order: "desc",
            signal,
          }),
    getNextPageParam: (lastPage) => {
      if (!lastPage.hasMore) {
        return undefined;
      }
      return activeFilterRequest ? (lastPage.nextCursor ?? undefined) : lastPage.page + 1;
    },
  });

  const starred = useQuery({
    queryKey: STARRED_QUERY_KEY,
    queryFn: ({ signal }) =>
      fetchTraces({ pageSize: 50, page: 1, isStarred: true, order: "desc", signal }),
  });

  const error = recent.error ?? starred.error;
  return {
    recentTraces: (recent.data?.pages.flatMap((page) => page.items) ??
      []) as TraceSummaryResponse[],
    starredTraces: (starred.data?.items ?? []) as TraceSummaryResponse[],
    isLoading: recent.isPending || starred.isPending,
    error: error ? (error instanceof Error ? error : new Error(String(error))) : null,
    hasMoreRecentTraces: recent.hasNextPage,
    isFetchingMoreRecentTraces: recent.isFetchingNextPage,
    fetchMoreRecentTraces: recent.fetchNextPage,
    refetch: () => {
      recent.refetch();
      starred.refetch();
    },
  };
}

/** Query keys for invalidating trace list cache (e.g. after star/unstar) */
export const traceListQueryKeys = {
  recent: RECENT_QUERY_KEY,
  starred: STARRED_QUERY_KEY,
};
