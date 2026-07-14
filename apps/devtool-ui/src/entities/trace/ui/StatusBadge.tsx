/**
 * Status Badge Component
 *
 * Reusable status badge component with unified styling
 */

import { getStatusConfig } from "@entities/trace/ui/status-config";
import { cn } from "@shared/lib/style";
import type { ExecutionStatus } from "src/entities/trace/types";

interface StatusBadgeProps {
  status: ExecutionStatus;
  showLabel?: boolean;
  className?: string;
  iconClassName?: string;
}

export function StatusBadge({
  status,
  showLabel = true,
  className,
  iconClassName,
}: StatusBadgeProps) {
  const config = getStatusConfig(status);
  const Icon = config.icon;

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-medium border",
        config.bgColor,
        config.color,
        config.borderColor,
        className,
      )}
    >
      <Icon className={cn("w-3 h-3", status === "running" && "animate-spin", iconClassName)} />
      {showLabel && <span>{config.label}</span>}
    </div>
  );
}
