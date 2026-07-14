/**
 * Collapsible Section Component
 *
 * UI-only: title, optional description, optional right content, and collapse state.
 * Does not contain editor logic; use with AutoHeightEditor / AutoHeightDiffEditor as children.
 */

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

export interface CollapsibleSectionProps {
  title: string;
  description?: string;
  rightContent?: React.ReactNode;
  children: React.ReactNode;
  defaultCollapsed?: boolean;
}

export function CollapsibleSection({
  title,
  description,
  rightContent,
  children,
  defaultCollapsed = false,
}: CollapsibleSectionProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  return (
    <div className="border-b border-border group">
      <div
        className="flex p-3 bg-muted/20 border-b border-border cursor-pointer hover:bg-muted/40 transition-colors select-none items-center"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="flex items-center justify-center w-4 h-4 text-foreground/80 shrink-0">
            {isCollapsed ? (
              <ChevronRight size={16} className="opacity-70" />
            ) : (
              <ChevronDown size={16} className="opacity-70" />
            )}
          </div>
          <div className="flex flex-col min-w-0">
            <div className="text-xs font-semibold text-foreground/90 tracking-wide">{title}</div>
            {description != null && (
              <div className="mt-1 text-[10px] text-muted-foreground font-mono opacity-80">
                {description}
              </div>
            )}
          </div>
        </div>
        {rightContent != null && (
          <div className="shrink-0 ml-2" onClick={(e) => e.stopPropagation()}>
            {rightContent}
          </div>
        )}
      </div>
      {!isCollapsed && <div className="transition-all duration-200">{children}</div>}
    </div>
  );
}
