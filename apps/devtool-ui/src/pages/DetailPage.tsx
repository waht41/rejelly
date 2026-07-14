import { useCommandViewStore } from "@features/command-view";
import { useTraceRouteSetup } from "@features/trace-route/useTraceRouteSetup.ts";
import { useViewSwitcherStore } from "@features/view-switcher";
import { AIPanel } from "@widgets/ai-panel";
import { HistoryPanel } from "@widgets/history/HistoryPanel.tsx";
import { DetailView } from "@widgets/trace-inspector";
import { TraceTree } from "@widgets/trace-tree";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

/**
 * Detail route: TraceTree (top) + History (bottom, resizable) + DetailView.
 */
export function DetailPage() {
  const { hasTrace } = useTraceRouteSetup();
  const showTraceHistory = useViewSwitcherStore((s) => s.showTraceHistory);
  const aiPanelOpen = useCommandViewStore((s) => s.aiPanelOpen);

  const mainContent = (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0">
        {hasTrace ? (
          <DetailView />
        ) : (
          <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground px-6 text-center">
            No trace selected yet. Connect via WebSocket or import a trace file to start.
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="h-full w-full flex">
      <PanelGroup id="detail-root-panels" direction="horizontal" className="flex-1 min-w-0">
        <Panel
          id="detail-tree-column"
          order={1}
          defaultSize={20}
          minSize={15}
          maxSize={40}
          className="bg-background border-r border-border"
        >
          <PanelGroup id="detail-left-panels" direction="vertical" className="h-full">
            <Panel
              id="detail-trace-tree"
              order={1}
              defaultSize={70}
              minSize={30}
              className="min-h-0"
            >
              <TraceTree />
            </Panel>

            {showTraceHistory && (
              <PanelResizeHandle className="h-1 bg-border hover:bg-resize-handle-hover transition-colors cursor-row-resize" />
            )}

            {showTraceHistory && (
              <Panel
                id="detail-trace-history"
                order={2}
                defaultSize={30}
                minSize={20}
                className="min-h-0"
              >
                <HistoryPanel mode="panel" />
              </Panel>
            )}
          </PanelGroup>
        </Panel>

        <PanelResizeHandle className="w-1 bg-border hover:bg-resize-handle-hover transition-colors cursor-col-resize" />

        <Panel
          id="detail-main"
          order={2}
          defaultSize={aiPanelOpen ? 58 : 80}
          minSize={35}
          className="bg-background"
        >
          {mainContent}
        </Panel>

        {aiPanelOpen && (
          <PanelResizeHandle className="w-1 bg-border hover:bg-resize-handle-hover transition-colors cursor-col-resize" />
        )}

        {aiPanelOpen && (
          <Panel
            id="detail-ai-panel"
            order={3}
            defaultSize={22}
            minSize={18}
            maxSize={45}
            className="bg-background"
          >
            <AIPanel />
          </Panel>
        )}
      </PanelGroup>
    </div>
  );
}
