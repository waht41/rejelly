/**
 * Trace File Loader Hook
 *
 * Thin UI bridge: wires file input/drop to processTraceFile (uploads to server),
 * then navigates to the imported trace and refreshes the server-backed history list.
 * Export: loads raw TraceEvent[] by traceId from the API, then downloads .jsonl.
 */

import { buildTracePath } from "@entities/route/routeUtils.ts";
import { traceListQueryKeys } from "@entities/trace/hooks/useTraceList";
import { useTraceStore } from "@entities/trace/store";
import {
  downloadTraceEventsAsJsonl,
  loadTraceEventsForExport,
  processTraceFile,
} from "@features/load-trace/lib/traceFile";
import { useToast } from "@shared/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { useCallback, useRef } from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";

export function useTraceFileLoader() {
  const traceId = useTraceStore((s) => s.currentTraceId ?? s.normalizedTrace?.id ?? null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mode = matchPath("/trace/:traceId?/waterfall", location.pathname) ? "waterfall" : "detail";

  const handleFile = useCallback(
    async (file: File) => {
      try {
        const traceIds = await processTraceFile(file);
        if (traceIds.length > 0) {
          await queryClient.invalidateQueries({ queryKey: traceListQueryKeys.recent });
          navigate(buildTracePath(traceIds[0], mode));
          toast({ title: "Imported", description: `Opened trace: ${traceIds[0]}` });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to parse trace file";
        toast({ title: "Import failed", description: message, variant: "destructive" });
      }
    },
    [mode, navigate, queryClient, toast],
  );

  const handleExportJson = useCallback(async () => {
    if (!traceId) return;
    try {
      const events = await loadTraceEventsForExport(traceId);
      if (events.length === 0) {
        toast({
          title: "Export failed",
          description: "No events found for this trace",
          variant: "destructive",
        });
        return;
      }
      downloadTraceEventsAsJsonl(events, traceId);
      toast({ title: "Exported", description: `trace-${traceId}.jsonl` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to export trace";
      toast({ title: "Export failed", description: message, variant: "destructive" });
    }
  }, [traceId, toast]);

  const handleOpenLocalFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelect = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      handleFile(file);
      event.target.value = "";
    },
    [handleFile],
  );

  return {
    handleFile,
    fileInputRef,
    handleExportJson,
    handleOpenLocalFile,
    handleFileSelect,
  };
}
