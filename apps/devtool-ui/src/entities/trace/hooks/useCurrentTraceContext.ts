/**
 * Unified current trace summary + optimistic updates: server list/detail via React Query.
 */

import type { TraceSummaryPatch } from "@entities/trace/api";
import { updateTrace } from "@entities/trace/api";
import type { TraceSummary } from "@entities/trace/store/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { traceListQueryKeys } from "./useTraceList";
import { traceSummaryQueryKey, useTraceSummary } from "./useTraceSummary";

function mergeSummaryPatch(
  traceId: string,
  previous: TraceSummary | undefined,
  patch: TraceSummaryPatch,
): TraceSummary {
  const tagsForStore =
    patch.tags !== undefined
      ? patch.tags === null
        ? null
        : JSON.stringify(patch.tags)
      : previous?.tags;

  return {
    traceId,
    timestamp: previous?.timestamp ?? Date.now(),
    name: patch.name !== undefined ? patch.name : previous?.name,
    nameSource: patch.name !== undefined ? "user" : previous?.nameSource,
    eventCount: previous?.eventCount ?? 0,
    isStarred: patch.isStarred !== undefined ? patch.isStarred : previous?.isStarred,
    tags: tagsForStore,
    agentId: previous?.agentId,
    adapterType: previous?.adapterType,
  };
}

export function useCurrentTraceContext(traceId: string | null) {
  const queryClient = useQueryClient();
  const { data: summary, isLoading } = useTraceSummary(traceId);

  const updateMutation = useMutation({
    mutationFn: (patch: TraceSummaryPatch) => {
      if (!traceId) throw new Error("No traceId");
      return updateTrace(traceId, patch);
    },
    onMutate: async (patch) => {
      if (!traceId) return { previous: undefined as TraceSummary | undefined };

      await queryClient.cancelQueries({ queryKey: traceSummaryQueryKey(traceId) });
      const previous = queryClient.getQueryData<TraceSummary>(traceSummaryQueryKey(traceId));
      queryClient.setQueryData<TraceSummary>(
        traceSummaryQueryKey(traceId),
        mergeSummaryPatch(traceId, previous, patch),
      );
      return { previous };
    },
    onError: (_err, _patch, context) => {
      if (!traceId) return;
      if (context?.previous !== undefined) {
        queryClient.setQueryData(traceSummaryQueryKey(traceId), context.previous);
      } else {
        queryClient.invalidateQueries({ queryKey: traceSummaryQueryKey(traceId) });
      }
    },
    onSettled: () => {
      if (!traceId) return;
      queryClient.invalidateQueries({ queryKey: traceListQueryKeys.recent });
      queryClient.invalidateQueries({ queryKey: traceListQueryKeys.starred });
    },
  });

  const updateSummary = async (patch: TraceSummaryPatch) => {
    if (!traceId) return;

    const updates: TraceSummaryPatch = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.isStarred !== undefined) updates.isStarred = patch.isStarred;
    if (patch.tags !== undefined) updates.tags = patch.tags;

    if (Object.keys(updates).length === 0) return;

    await updateMutation.mutateAsync(updates);
  };

  return {
    summary,
    isLoading,
    updateSummary,
  };
}
