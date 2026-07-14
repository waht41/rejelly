/**
 * History Panel: supports two modes
 * - Panel mode: embedded in bottom-left corner, shares width with TraceTree, resizable via handler
 * - Drawer mode: slides in from left as floating panel, closes on overlay click
 */

import { useViewSwitcherStore } from "@features/view-switcher";
import { cn } from "@shared/lib/style";
import { TraceHistory } from "./TraceHistory";

const PANEL_WIDTH = 320;

interface HistoryPanelProps {
  /** Panel mode: embedded layout; Drawer mode: floating overlay */
  mode: "panel" | "drawer";
  /** Called when drawer mode closes (overlay click or trace select) */
  onClose?: () => void;
}

export function HistoryPanel({ mode, onClose }: HistoryPanelProps) {
  const setOpen = useViewSwitcherStore((s) => s.setShowTraceHistory);

  const handleClose = () => {
    setOpen(false);
    onClose?.();
  };

  const list = <TraceHistory onAfterSelect={handleClose} />;

  // Drawer mode: floating panel with overlay
  if (mode === "drawer") {
    return (
      <>
        {/* Overlay - right of sidebar (w-12) so sidebar stays visible and clickable */}
        <div
          className="fixed inset-0 left-12 z-40 bg-black/40 transition-opacity"
          aria-hidden
          onClick={handleClose}
        />

        {/* Drawer panel - right of sidebar, slides in from left */}
        <div
          className={cn(
            "fixed left-12 top-0 z-50 h-full flex flex-col",
            "bg-background border-r border-border shadow-lg",
            "animate-in slide-in-from-left-4 duration-200",
          )}
          style={{ width: PANEL_WIDTH }}
          role="dialog"
          aria-label="Trace History"
        >
          <div className="flex-1 min-h-0 overflow-hidden">{list}</div>
        </div>
      </>
    );
  }

  // Panel mode: embedded in layout
  return (
    <div className="h-full w-full flex flex-col bg-background border-t border-border">
      <div className="flex-1 min-h-0 overflow-hidden">{list}</div>
    </div>
  );
}
