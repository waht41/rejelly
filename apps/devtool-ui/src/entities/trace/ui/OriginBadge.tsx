/**
 * Origin Badge Component
 *
 * Displays which parent generation spawned this child node
 * Uses "↳ G1" format to indicate "Spawned at Gen 1"
 * Styled with cool blue-gray/slate colors to distinguish from parent's amber status badge
 */

import { cn } from "@shared/lib/style";

interface OriginBadgeProps {
  /** Generation ID that spawned this child */
  genId: number;
  /** Optional className for additional styling */
  className?: string;
}

export function OriginBadge({ genId, className }: OriginBadgeProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 px-1.5 py-0.5 rounded-sm",
        "bg-badge-bg text-badge-text border border-badge-border",
        "text-[10px] font-mono font-medium leading-none",
        className,
      )}
    >
      <span className="text-[10px] leading-none">↳</span>
      <span>G{genId}</span>
    </div>
  );
}
