/**
 * Generic Timeline Header Component
 *
 * Reusable timeline header for displaying generations as colored blocks
 * Used by agent timeline headers
 */

import { getStatusConfig } from "@entities/trace/ui/status-config";
import { formatCompactTokenCount, formatDuration } from "@shared/lib/formatters";
import { cn } from "@shared/lib/style";
import type { ExecutionStatus } from "src/entities/trace/types";

interface GenerationItem {
  id: number;
  status: ExecutionStatus;
  startTime: number;
  endTime?: number;
  duration?: number;
  finishReason?: string;
  /** Sum of budget:update delta.totalTokens mounted on this generation */
  budgetTokens?: number;
}

interface GenericTimelineHeaderProps {
  generations: GenerationItem[];
  selectedId?: number;
  onSelect: (id: number) => void;
  title?: string;
  emptyMessage?: string;
}

interface GenerationViewModel {
  id: number;
  finishReason?: string;
  duration: number;
  hasBudget: boolean;
  budgetTokens?: number;
  itemWidth: number;
  titleText: string;
  isSelected: boolean;
  config: ReturnType<typeof getStatusConfig>;
}

// Logarithmic scale: time -> pixel width (avoids layout jitter from totalDuration denominator)
function calculateWidth(durationMs: number): number {
  const MIN_WIDTH = 120;
  const MAX_WIDTH = 200;

  if (durationMs <= 0) return MIN_WIDTH;

  const durationSec = durationMs / 1000;
  if (durationSec <= 1) return MIN_WIDTH;

  const scaleFactor = 30;
  const width = MIN_WIDTH + Math.log2(durationSec) * scaleFactor;
  return Math.min(Math.max(width, MIN_WIDTH), MAX_WIDTH);
}

function getDurationMs(item: GenerationItem): number {
  if (item.duration !== undefined) return item.duration;
  if (item.endTime !== undefined) return item.endTime - item.startTime;
  return 0;
}

function toGenerationViewModel(item: GenerationItem, selectedId?: number): GenerationViewModel {
  const config = getStatusConfig(item.status);
  const duration = getDurationMs(item);
  const hasBudget = item.budgetTokens !== undefined && item.budgetTokens > 0;
  const itemWidth = calculateWidth(duration);
  const titleParts = [
    `Gen ${item.id}: ${config.label} (${formatDuration(duration)})`,
    hasBudget && item.budgetTokens !== undefined
      ? `${formatCompactTokenCount(item.budgetTokens)} tks`
      : null,
    item.finishReason || "unknown",
  ].filter(Boolean);

  return {
    id: item.id,
    finishReason: item.finishReason,
    duration,
    hasBudget,
    budgetTokens: item.budgetTokens,
    itemWidth,
    titleText: titleParts.join(" — "),
    isSelected: selectedId === item.id,
    config,
  };
}

function TimelineBlock({
  item,
  onSelect,
}: {
  item: GenerationViewModel;
  onSelect: (id: number) => void;
}) {
  return (
    <button
      onClick={() => onSelect(item.id)}
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 rounded border transition-all",
        "text-xs font-medium cursor-pointer",
        "flex-shrink-0",
        item.config.borderColor,
        item.config.bgColor,
        item.isSelected && "border-2 border-amber-400 ring-2 ring-amber-300 ring-offset-1",
      )}
      style={{ width: `${item.itemWidth}px` }}
      title={item.titleText}
    >
      <span className="text-[10px]">{item.config.emoji}</span>
      <span className="font-semibold">Gen {item.id}</span>
      {item.duration > 0 && (
        <span className="text-[10px] text-muted-foreground whitespace-nowrap overflow-hidden text-ellipsis">
          {formatDuration(item.duration)}
        </span>
      )}
      {item.hasBudget && item.budgetTokens !== undefined && (
        <>
          <span className="text-[10px] text-muted-foreground/80 shrink-0">|</span>
          <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
            {formatCompactTokenCount(item.budgetTokens)} tks
          </span>
        </>
      )}
    </button>
  );
}

function TimelineDetailBar({ item }: { item?: GenerationViewModel }) {
  if (!item) return null;

  return (
    <div className="h-5 px-3 flex items-center gap-2 text-[10px] text-muted-foreground border-t border-border/50">
      <span className="font-medium">
        Status: {item.config.emoji} {item.config.label}
      </span>
      {item.finishReason && (
        <>
          <span>•</span>
          <span>Reason: {item.finishReason}</span>
        </>
      )}
      {item.duration > 0 && (
        <>
          <span>•</span>
          <span>Duration: {formatDuration(item.duration)}</span>
        </>
      )}
    </div>
  );
}

export function GenericTimelineHeader({
  generations,
  selectedId,
  onSelect,
  title = "Timeline",
  emptyMessage = "No generations available",
}: GenericTimelineHeaderProps) {
  const viewModels = generations.map((item) => toGenerationViewModel(item, selectedId));
  const selectedItem =
    selectedId != null ? viewModels.find((item) => item.id === selectedId) : undefined;

  if (generations.length === 0) {
    return (
      <div className="h-14 flex items-center justify-center border-b border-border bg-muted/20">
        <div className="text-xs text-muted-foreground">{emptyMessage}</div>
      </div>
    );
  }

  return (
    <div className="h-14 flex flex-col border-b border-border bg-muted/20">
      {/* Status bar */}
      <div className="flex-1 flex items-center px-3 gap-2">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex-shrink-0">
          {title}
        </div>
        <div className="flex-1 flex items-center gap-1 overflow-x-auto">
          {viewModels.map((item) => (
            <TimelineBlock key={item.id} item={item} onSelect={onSelect} />
          ))}
        </div>
      </div>
      {/* Info bar - shows selected generation details */}
      {selectedId != null && <TimelineDetailBar item={selectedItem} />}
    </div>
  );
}
