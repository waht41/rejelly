import { useCommandViewStore } from "@features/command-view";
import { useTraceRouteSetup } from "@features/trace-route/useTraceRouteSetup.ts";
import { useViewSwitcherStore } from "@features/view-switcher";
import { AIPanel } from "@widgets/ai-panel";
import { HistoryPanel } from "@widgets/history/HistoryPanel.tsx";
import { Waterfall } from "@widgets/waterfall/Waterfall.tsx";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

/**
 * Waterfall route: full-width Waterfall; History opens as a drawer.
 */
export function WaterfallPage() {
  const { hasTrace } = useTraceRouteSetup();
  const showTraceHistory = useViewSwitcherStore((s) => s.showTraceHistory);
  const aiPanelOpen = useCommandViewStore((s) => s.aiPanelOpen);

  return (
    <div className="h-full w-full flex flex-col relative">
      <PanelGroup
        id="waterfall-root-panels"
        direction="horizontal"
        className="h-full min-h-0 min-w-0"
      >
        <Panel
          id="waterfall-main"
          order={1}
          defaultSize={aiPanelOpen ? 76 : 100}
          minSize={45}
          className="min-w-0"
        >
          <div className="h-full flex flex-col">
            <div className="flex-1 min-h-0">
              {hasTrace ? (
                <Waterfall />
              ) : (
                <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground px-6 text-center">
                  No trace selected yet. Connect via WebSocket or import a trace file to start.
                </div>
              )}
            </div>
          </div>
        </Panel>

        {aiPanelOpen && (
          <PanelResizeHandle className="w-1 bg-border hover:bg-resize-handle-hover transition-colors cursor-col-resize" />
        )}

        {aiPanelOpen && (
          <Panel
            id="waterfall-ai-panel"
            order={2}
            defaultSize={24}
            minSize={18}
            maxSize={45}
            className="bg-background"
          >
            <AIPanel />
          </Panel>
        )}
      </PanelGroup>
      {showTraceHistory && <HistoryPanel mode="drawer" />}
    </div>
  );
}
