/**
 * Single row for flat trace tree (no recursion; data from {@link buildFlatTraceTree}).
 */

import type { FlatTraceNode } from "@entities/trace/lib/treeView";
import { useTraceTreeStore } from "@entities/trace/store/useTraceTreeStore";
import { GenerationBadge } from "@entities/trace/ui/GenerationBadge";
import { LogBadge } from "@entities/trace/ui/LogBadge";
import { OriginBadge } from "@entities/trace/ui/OriginBadge";
import { getStatusConfig } from "@entities/trace/ui/status-config";
import { cn } from "@shared/lib/style";
import { useSelectionStore } from "@shared/store/useSelectionStore";
import { Bot, ChevronDown, ChevronRight, Code, Layers } from "lucide-react";

interface TraceTreeRowProps {
  data: FlatTraceNode;
}

export function TraceTreeRow({ data }: TraceTreeRowProps) {
  const { node, level, isExpanded, isGrayedOut, hasChildren } = data;

  const toggleNode = useTraceTreeStore((state) => state.toggleNode);

  const isSelected = useSelectionStore((state) => state.activeNodeId === node.spanId);
  const setActiveNode = useSelectionStore((state) => state.setActiveNode);
  const selectGeneration = useSelectionStore((state) => state.selectGeneration);

  const onToggle = () => toggleNode(node.spanId);

  const handleSelect = (_e: React.MouseEvent) => {
    setActiveNode(node.spanId, node.type);
    if (node.type === "agent" && data.autoSelectGenerationIdOnClick !== null) {
      selectGeneration(node.spanId, data.autoSelectGenerationIdOnClick);
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasChildren) {
      onToggle();
    }
  };

  const handleArrowClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle();
  };

  const statusConfig = getStatusConfig(node.status);
  const StatusIcon = statusConfig.icon;

  const getNodeTypeIcon = () => {
    const iconColor = isSelected
      ? "text-white/90"
      : node.type === "agent"
        ? "text-tree-item-icon-agent"
        : node.type === "runWith"
          ? "text-muted-foreground"
          : "text-tree-item-icon-span";

    if (node.type === "agent") {
      return <Bot className={cn("w-3.5 h-3.5", iconColor)} />;
    }
    if (node.type === "span") {
      return <Code className={cn("w-3.5 h-3.5", iconColor)} />;
    }
    if (node.type === "runWith") {
      return <Layers className={cn("w-3.5 h-3.5", iconColor)} />;
    }
    return null;
  };

  const renderGenerationBadge = () => {
    const badge = data.generationBadge;
    if (!badge) return null;
    if (badge.kind === "singleCount") {
      return <span className="text-xs text-muted-foreground/50">({badge.count})</span>;
    }
    return <GenerationBadge current={badge.current} total={badge.total} isSelected={isSelected} />;
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1 px-2 py-1 text-sm cursor-pointer select-none",
        "transition-all duration-200 rounded-sm",
        isSelected
          ? "bg-tree-item-selected text-tree-item-selected-text shadow-sm"
          : cn("text-tree-item-text", "hover:bg-tree-item-hover hover:text-tree-item-hover-text"),
        isGrayedOut && !isSelected && "opacity-50",
      )}
      style={{ paddingLeft: `${level * 12 + 8}px` }}
      onClick={handleSelect}
      onDoubleClick={handleDoubleClick}
    >
      {hasChildren ? (
        <button onClick={handleArrowClick} className={cn("p-0.5 rounded-sm transition-colors")}>
          {isExpanded ? (
            <ChevronDown
              className={cn("w-3 h-3", isSelected ? "text-white/90" : "text-muted-foreground")}
            />
          ) : (
            <ChevronRight
              className={cn("w-3 h-3", isSelected ? "text-white/90" : "text-muted-foreground")}
            />
          )}
        </button>
      ) : (
        <div className="w-4" />
      )}
      {getNodeTypeIcon()}
      <StatusIcon
        className={cn(
          "w-3 h-3",
          isSelected ? "text-white/90" : statusConfig.color,
          node.status === "running" && "animate-spin",
        )}
      />
      <span
        className={cn("flex-1 truncate", !isSelected && isGrayedOut && "text-muted-foreground")}
      >
        {node.name}
      </span>
      <LogBadge count={node.logCount} level={node.maxLogLevel} selected={isSelected} />

      {data.showOriginBadge && data.calledByGenerationId !== null && (
        <OriginBadge genId={data.calledByGenerationId} />
      )}

      {node.type === "agent" && renderGenerationBadge()}
    </div>
  );
}
