/**
 * Server trace summary for a single trace id (React Query cache as source of truth).
 */

import { fetchTraceSummary } from "@entities/trace/api";
import { mapTraceSummaryResponse } from "@entities/trace/lib/mapTraceSummaryResponse";
import { useQuery } from "@tanstack/react-query";

export const traceSummaryQueryKey = (traceId: string) => ["traceSummary", traceId] as const;

export function useTraceSummary(traceId: string | null) {
  return useQuery({
    queryKey: traceId ? traceSummaryQueryKey(traceId) : ["traceSummary", "__none__"],
    queryFn: () => fetchTraceSummary(traceId!).then(mapTraceSummaryResponse),
    enabled: !!traceId,
    staleTime: 5 * 60 * 1000,
  });
}
