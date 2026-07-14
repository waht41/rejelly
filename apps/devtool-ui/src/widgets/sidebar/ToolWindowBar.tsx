/**
 * Tool Window Bar Component
 *
 * Left sidebar tool window bar similar to WebStorm
 * Contains tool window buttons (TraceTree, Waterfall, List, etc.)
 */

import { buildTracePath } from "@entities/route/routeUtils.ts";
import { useTraceStore } from "@entities/trace/store";
import { useViewSwitcherStore } from "@features/view-switcher";
import { cn } from "@shared/lib/style.ts";
import type { LucideIcon } from "lucide-react";
import { GanttChart, List, ListTree } from "lucide-react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";

const toolBarButtonClass =
  "w-10 h-10 flex items-center justify-center rounded transition-colors hover:bg-muted";

function ToolBarButton({
  title,
  active,
  onClick,
  icon: Icon,
}: {
  title: string;
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(toolBarButtonClass, active && "bg-muted")}
      title={title}
    >
      <Icon className={cn("w-5 h-5", active ? "text-foreground" : "text-muted-foreground")} />
    </button>
  );
}

export function ToolWindowBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const currentTraceId = useTraceStore((s) => s.currentTraceId);
  const showTraceHistory = useViewSwitcherStore((s) => s.showTraceHistory);
  const toggleTraceHistory = useViewSwitcherStore((s) => s.toggleTraceHistory);
  const isDetailRoute = !!matchPath("/trace/:traceId?/detail", location.pathname);
  const isWaterfallRoute = !!matchPath("/trace/:traceId?/waterfall", location.pathname);

  return (
    <div className="w-12 h-full bg-card border-r border-border flex flex-col items-center py-2 gap-1">
      <ToolBarButton
        title="Trace Tree / Detail"
        active={isDetailRoute}
        onClick={() => navigate(buildTracePath(currentTraceId, "detail"))}
        icon={ListTree}
      />
      <ToolBarButton
        title="Waterfall"
        active={isWaterfallRoute}
        onClick={() => navigate(buildTracePath(currentTraceId, "waterfall"))}
        icon={GanttChart}
      />

      <div className="flex-1 min-h-2" />

      <ToolBarButton
        title="Trace History"
        active={showTraceHistory}
        onClick={toggleTraceHistory}
        icon={List}
      />
    </div>
  );
}
