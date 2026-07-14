import type { NormalizedTrace } from "@entities/trace/types";
import { cn } from "@shared/lib/style";
import { MessageSquare } from "lucide-react";

interface LogBadgeProps {
  count?: number;
  level?: NormalizedTrace.LogLevel;
  selected?: boolean;
  className?: string;
}

function getLogBadgeClass(level: NormalizedTrace.LogLevel | undefined, selected: boolean) {
  if (selected) {
    return "border-white/20 bg-white/15 text-white/90";
  }
  if (level === "error") {
    return "border-destructive/20 bg-destructive/10 text-destructive";
  }
  if (level === "warning") {
    return "border-amber-500/20 bg-amber-500/15 text-amber-500";
  }
  return "border-border bg-muted text-muted-foreground";
}

export function LogBadge({ count, level, selected = false, className }: LogBadgeProps) {
  if (!count || count <= 0) return null;
  const title = `${count} log${count === 1 ? "" : "s"}${level ? ` - max ${level}` : ""}`;

  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 shrink-0 items-center gap-1 rounded border px-1 text-[10px] leading-none",
        getLogBadgeClass(level, selected),
        className,
      )}
      title={title}
      aria-label={title}
    >
      <MessageSquare className="h-3 w-3" />
      <span className="tabular-nums">{count}</span>
    </span>
  );
}
