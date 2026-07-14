/**
 * Trace Tree Header Component
 *
 * Header section with trace summary (left) and utility toolbar (right).
 * Trace switching / history lives in TraceHistory drawer elsewhere in the shell.
 */

import type { TraceSummaryPatch } from "@entities/trace/api";
import { STATUS_CONFIG } from "@entities/trace/ui/status-config";
import { formatTimeAgo } from "@shared/lib/formatters";
import { cn } from "@shared/lib/style";
import { Popover, PopoverContent, PopoverTrigger } from "@shared/ui/popover";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Download,
  FolderOpen,
  type LucideIcon,
  Network,
  RotateCcw,
  Star,
} from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";

/** Full-width row in trace menu popover: icon + label, muted hover */
function TraceHeaderPopoverMenuButton({
  icon: Icon,
  label,
  className,
  ...rest
}: {
  icon: LucideIcon;
  label: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "flex items-center gap-2 w-full px-3 py-2 text-xs hover:bg-muted rounded-sm text-left transition-colors",
        className,
      )}
      {...rest}
    >
      <Icon className="w-3.5 h-3.5 text-muted-foreground" />
      <span>{label}</span>
    </button>
  );
}

/** Compact icon-only controls in the header toolbar (star / collapse / expand) */
function TraceHeaderToolbarIconButton({
  title,
  icon: Icon,
  onClick,
  className,
  iconClassName,
  ...rest
}: {
  title: string;
  icon: LucideIcon;
  onClick: () => void;
  /** Extra classes on the Lucide icon (e.g. star fill when active) */
  iconClassName?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "title" | "type">) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "p-2 hover:bg-accent hover:text-foreground rounded-sm text-muted-foreground transition-colors",
        className,
      )}
      {...rest}
    >
      <Icon className={cn("w-4 h-4", iconClassName)} />
    </button>
  );
}

interface TraceTreeHeaderProps {
  traceId?: string;
  traceName?: string;
  /** Trace start time (ms) for "time ago" in subtitle; defaults to now when missing. */
  traceStartTime?: number;
  isConnected?: boolean;
  isStarred?: boolean;
  onExportJson: () => void;
  onOpenLocalFile: () => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onReconnect?: () => void;
  /** Partial patch; omit keys to leave them unchanged (PATCH semantics). */
  onUpdateSummary?: (patch: TraceSummaryPatch) => void | Promise<void>;
}

export function TraceTreeHeader({
  traceId,
  traceName,
  traceStartTime,
  isConnected = false,
  isStarred = false,
  onExportJson,
  onOpenLocalFile,
  onCollapseAll,
  onExpandAll,
  onReconnect,
  onUpdateSummary,
}: TraceTreeHeaderProps) {
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);

  // Inline rename: focus/select on enter edit mode
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const statusColorHex = isConnected ? STATUS_CONFIG.success.hex : STATUS_CONFIG.error.hex;
  const statusBgClass = isConnected ? STATUS_CONFIG.success.bgColor : STATUS_CONFIG.error.bgColor;
  const statusTextClass = isConnected ? STATUS_CONFIG.success.color : STATUS_CONFIG.error.color;

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const displayName = traceName || "Untitled Trace";
  const shortTraceId = traceId
    ? traceId.length > 12
      ? `${traceId.slice(0, 12)}...`
      : traceId
    : "No Trace";
  const traceTimestamp = traceStartTime ?? Date.now();

  // Handle double click to start editing
  const handleDoubleClick = () => {
    if (!onUpdateSummary || !traceId) return;
    setEditValue(traceName || "");
    setIsEditing(true);
  };

  // Handle save (user-visible trace name)
  const handleSave = () => {
    const trimmedValue = editValue.trim() || "Untitled Trace";
    if (onUpdateSummary && trimmedValue !== (traceName || "")) {
      onUpdateSummary({ name: trimmedValue });
    }
    setIsEditing(false);
  };

  // Handle keydown in rename input — Enter: blur so onBlur runs save once; Escape: discard without PATCH
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      inputRef.current?.blur();
    } else if (e.key === "Escape") {
      // Handle cancel — revert local edit, no PATCH
      setIsEditing(false);
      setEditValue("");
    }
  };

  return (
    <div className="px-3 py-2 h-14 border-b border-border flex items-center justify-between relative">
      {/* Left: Context Switcher */}
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <Popover open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
          {/* Icon trigger: opens trace menu popover */}
          <PopoverTrigger asChild>
            <button
              type="button"
              title="Open trace menu"
              className={cn(
                "flex-shrink-0 w-6 h-6 flex items-center justify-center relative rounded-md cursor-pointer",
                "hover:bg-accent hover:text-foreground transition-colors",
                isPopoverOpen && "bg-accent text-foreground",
              )}
            >
              <Network
                className={cn(
                  "w-4 h-4",
                  isPopoverOpen ? "text-foreground" : "text-muted-foreground",
                )}
              />
              {/* Status badge on icon — top right to avoid overlap */}
              <div
                className={cn(
                  "absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border-[1.5px] border-background",
                  isConnected && "animate-pulse",
                )}
                style={{ backgroundColor: statusColorHex }}
              />
            </button>
          </PopoverTrigger>

          <PopoverContent className="w-[280px] p-0 flex flex-col shadow-lg" align="start">
            {/* Actions: open local file, export JSON */}
            <div className="p-1">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 px-2 py-1">
                Actions
              </div>
              <div className="flex flex-col gap-0.5">
                <TraceHeaderPopoverMenuButton
                  icon={FolderOpen}
                  label="Open Local File"
                  onClick={() => {
                    onOpenLocalFile();
                    setIsPopoverOpen(false);
                  }}
                />
                <TraceHeaderPopoverMenuButton
                  icon={Download}
                  label="Export JSON"
                  onClick={() => {
                    onExportJson();
                    setIsPopoverOpen(false);
                  }}
                />
              </div>
            </div>

            {/* Connection status footer — immersive status bar */}
            <div
              className={cn(
                "mt-auto border-t border-border px-3 py-2 text-xs flex items-center justify-between",
                statusBgClass,
                statusTextClass,
              )}
            >
              <div className="flex items-center gap-2">
                <div
                  className={cn("w-1.5 h-1.5 rounded-full", isConnected && "animate-pulse")}
                  style={{ backgroundColor: statusColorHex }}
                />
                <span className="font-medium">
                  {isConnected ? "System Online" : "Disconnected"}
                </span>
              </div>
              {/* Reconnect button when disconnected */}
              {!isConnected && onReconnect && (
                <button
                  type="button"
                  onClick={() => {
                    onReconnect();
                    setIsPopoverOpen(false);
                  }}
                  className={cn(
                    "text-[10px] border px-2 py-1 rounded transition-colors flex items-center gap-1",
                    `${STATUS_CONFIG.error.borderColor} hover:${STATUS_CONFIG.error.bgColor}`,
                  )}
                >
                  <RotateCcw className="w-3 h-3" />
                  Reconnect
                </button>
              )}
            </div>
          </PopoverContent>
        </Popover>

        {/* Main content: Trace name + ID (display); double-click renames when allowed */}
        <div className="flex-1 min-w-0 flex flex-col items-start overflow-hidden">
          {/* Top row: name with double-click to edit (star lives in right toolbar) */}
          <div className="flex items-center gap-1.5 w-full min-w-0">
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={handleSave}
                onKeyDown={handleKeyDown}
                className="text-sm font-semibold bg-transparent border border-input rounded px-1 py-0 w-full min-w-0 outline-none focus:border-primary"
              />
            ) : (
              <span
                onDoubleClick={handleDoubleClick}
                title={onUpdateSummary ? "Double-click to rename" : undefined}
                className={cn(
                  "text-sm font-semibold text-foreground truncate flex-1 min-w-0",
                  onUpdateSummary &&
                    "cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 transition-colors",
                )}
              >
                {displayName}
              </span>
            )}
          </div>

          {/* Bottom row: metadata — trace id and time on one line */}
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground w-full min-w-0 mt-0.5 h-4">
            <span className="truncate min-w-0 flex-1">
              <span className="font-mono text-muted-foreground">#{shortTraceId}</span>
              <span className="mx-1.5">·</span>
              <span className="tabular-nums">{formatTimeAgo(traceTimestamp)}</span>
            </span>
          </div>
        </div>
      </div>

      {/* Right: star + collapse + expand (shared toolbar control style) */}
      <div className="flex items-center gap-1 self-stretch pl-2 border-l border-border/40 ml-2 flex-shrink-0">
        {!isEditing && onUpdateSummary && (
          <TraceHeaderToolbarIconButton
            title={isStarred ? "Unstar trace" : "Star trace"}
            icon={Star}
            onClick={() => onUpdateSummary({ isStarred: !isStarred })}
            className={
              isStarred
                ? "text-yellow-500 hover:text-yellow-600"
                : "text-muted-foreground hover:text-yellow-500"
            }
            iconClassName={isStarred ? "fill-yellow-500" : undefined}
          />
        )}
        <TraceHeaderToolbarIconButton
          title="Collapse All"
          icon={ChevronsDownUp}
          onClick={onCollapseAll}
        />
        <TraceHeaderToolbarIconButton
          title="Expand All"
          icon={ChevronsUpDown}
          onClick={onExpandAll}
        />
      </div>
    </div>
  );
}
