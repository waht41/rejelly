/**
 * Status Bar — minimal metadata from NormalizedTrace only.
 * Shows name, status, and duration for the active node (or whole trace when nothing selected).
 */

import { selectBudgetSummaryForSpan } from "@entities/trace/lib/budgetSelectors.ts";
import { getGenerationsForHost } from "@entities/trace/lib/treeFinder";
import { useTraceStore } from "@entities/trace/store";
import { useSelectionStore } from "@shared/store/useSelectionStore";
import { Clock } from "lucide-react";
import { useMemo } from "react";
import type { ExecutionStatus } from "src/entities/trace/types";
import { getStatusConfig } from "../../entities/trace/ui/status-config";
import { formatCompactTokenCount, formatDuration } from "../../shared/lib/formatters";
import { cn } from "../../shared/lib/style";

function durationLabelMs(
  status: ExecutionStatus | undefined,
  durationMs: number | undefined,
  startTime: number,
  endTime: number | undefined,
): string {
  if (durationMs != null && durationMs >= 0) {
    return formatDuration(durationMs);
  }
  if (endTime != null && endTime >= startTime) {
    return formatDuration(endTime - startTime);
  }
  if (status === "running") {
    return "…";
  }
  return "—";
}

function getLastGenerationAggregateTokens(
  trace: Parameters<typeof getGenerationsForHost>[0],
  agentSpanId: string,
): number | undefined {
  const generations = getGenerationsForHost(trace, agentSpanId).filter(
    (g) => g.type === "generation",
  );
  const lastGeneration = generations[generations.length - 1];
  if (!lastGeneration) return undefined;

  const totalTokens = selectBudgetSummaryForSpan(trace, lastGeneration.spanId).own.totalTokens;
  if (!Number.isFinite(totalTokens) || totalTokens < 0) return undefined;
  return Math.round(totalTokens);
}

export function StatusBar() {
  const normalizedTrace = useTraceStore((state) => state.normalizedTrace);
  const activeNodeId = useSelectionStore((state) => state.activeNodeId);

  const line = useMemo(() => {
    if (!normalizedTrace) {
      return null;
    }

    const node = activeNodeId ? normalizedTrace.nodeMap[activeNodeId] : undefined;

    if (node) {
      const durationMs = node.duration;
      const label = durationLabelMs(node.status, durationMs, node.startTime, node.endTime);
      const aggregateTokens =
        node.type === "agent"
          ? getLastGenerationAggregateTokens(normalizedTrace, node.spanId)
          : undefined;
      return {
        name: node.name,
        status: node.status,
        durationLabel: label,
        aggregateTokenLabel:
          aggregateTokens !== undefined
            ? `${formatCompactTokenCount(aggregateTokens)} tks`
            : undefined,
      };
    }

    const durationMs =
      normalizedTrace.endTime != null
        ? normalizedTrace.endTime - normalizedTrace.startTime
        : undefined;
    const label = durationLabelMs(
      normalizedTrace.status,
      durationMs,
      normalizedTrace.startTime,
      normalizedTrace.endTime,
    );
    return {
      name: normalizedTrace.name ?? normalizedTrace.id,
      status: normalizedTrace.status,
      durationLabel: label,
      aggregateTokenLabel: undefined,
    };
  }, [normalizedTrace, activeNodeId]);

  const getStatusIcon = (status: ExecutionStatus) => {
    const config = getStatusConfig(status);
    const Icon = config.icon;
    return <Icon className={cn("w-3 h-3", status === "running" && "animate-spin")} />;
  };

  if (!line) {
    return (
      <div className="h-6 flex items-center justify-between px-3 text-[11px] border-t border-border bg-muted/30 text-muted-foreground">
        <span>Ready</span>
      </div>
    );
  }

  const statusConfig = getStatusConfig(line.status);

  return (
    <div className="h-6 flex items-center justify-between px-3 text-[11px] border-t border-border bg-muted/30">
      <div className="flex items-center gap-3 min-w-0 text-muted-foreground">
        <div className={cn("flex items-center gap-1.5 shrink-0", statusConfig.color)}>
          {getStatusIcon(line.status)}
          <span className="font-medium">{statusConfig.label}</span>
        </div>
        <span className="text-muted-foreground/70 shrink-0">•</span>
        <span className="font-mono text-[10px] truncate" title={line.name}>
          {line.name}
        </span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0 text-muted-foreground">
        {line.aggregateTokenLabel && (
          <>
            <span className="font-mono tabular-nums">{line.aggregateTokenLabel}</span>
            <span className="text-muted-foreground/70">•</span>
          </>
        )}
        <Clock className="w-3 h-3" />
        <span className="font-mono tabular-nums">{line.durationLabel}</span>
      </div>
    </div>
  );
}
