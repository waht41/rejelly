/**
 * Generation Badge Component
 *
 * Displays generation count with different styles based on whether viewing latest or historical generation
 * - Latest/Finished: Muted gray style (silent information)
 * - History/Debugging: Amber/yellow highlight (warning that viewing old data)
 */

import { cn } from "@shared/lib/style";

interface GenerationBadgeProps {
  /** Current selected generation ID (null means latest) */
  current: number | null;
  /** Total number of generations */
  total: number;
  /** Whether the parent node is selected (affects badge styling) */
  isSelected?: boolean;
  /** Optional className for additional styling */
  className?: string;
}

export function GenerationBadge({
  current,
  total,
  isSelected = false,
  className,
}: GenerationBadgeProps) {
  // Check if viewing latest generation
  // current === null means viewing latest (set by parent component)
  const isLatest = current === null;

  if (isLatest) {
    // Silent state: show total count in muted style
    return (
      <span className={cn("ml-auto text-xs text-muted-foreground font-mono opacity-70", className)}>
        {total} gens
      </span>
    );
  }

  // History state: highlight with amber/yellow to warn user viewing old data
  // When selected (blue background), use dark semi-transparent background with bright amber text
  // When not selected, use the original amber background style
  return (
    <div
      className={cn(
        "ml-auto flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[10px] font-mono font-medium border",
        isSelected
          ? "bg-black/20 text-amber-300 border-transparent"
          : "bg-amber-500/15 text-amber-500 border-amber-500/20",
        className,
      )}
    >
      {!isSelected && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />}
      GEN {current} | Total: {total}
    </div>
  );
}
