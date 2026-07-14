import { Outlet } from "react-router-dom";
import { ToolWindowBar } from "../widgets/sidebar";
import { StatusBar } from "../widgets/status-bar/StatusBar";

function AppLayout() {
  return (
    <div className="h-full w-full flex flex-col bg-background">
      <div className="flex-1 min-h-0 flex">
        <div className="w-12 flex-shrink-0 bg-background">
          <ToolWindowBar />
        </div>
        <div className="flex-1 min-w-0">
          <Outlet />
        </div>
      </div>
      <div className="flex-shrink-0">
        <StatusBar />
      </div>
    </div>
  );
}

export { AppLayout };
