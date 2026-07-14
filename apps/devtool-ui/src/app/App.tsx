import { useAppWebSocket } from "@features/connect-ws/useAppWebSocket";
import { useTraceConnection } from "@features/load-trace/useTraceConnection.ts";
import { DetailPage } from "@pages/DetailPage.tsx";
import { NotFoundPage } from "@pages/NotFoundPage.tsx";
import { TraceRootRedirect } from "@pages/TraceRootRedirect.tsx";
import { WaterfallPage } from "@pages/WaterfallPage.tsx";
import { getWsSocketAdapter } from "@shared/lib/getWsSocketAdapter.ts";
import { useMemo } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "../shared/ui/toaster";
import { GlobalTraceDropZone } from "../widgets/drop-zone/GlobalTraceDropZone";
import { AppLayout } from "./AppLayout";

function AppContent() {
  useAppWebSocket();
  const socketAdapter = useMemo(() => getWsSocketAdapter(), []);
  useTraceConnection(socketAdapter);

  return (
    <>
      <Toaster />
      <GlobalTraceDropZone>
        <Routes>
          <Route path="/" element={<AppLayout />}>
            <Route index element={<Navigate to="/trace/detail" replace />} />

            {/* Order: concrete views first, then /trace/:traceId → detail so /trace/detail is not captured as an id */}
            <Route path="trace/:traceId?/detail" element={<DetailPage />} />
            <Route path="trace/:traceId?/waterfall" element={<WaterfallPage />} />
            <Route path="trace/:traceId" element={<TraceRootRedirect />} />

            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </GlobalTraceDropZone>
    </>
  );
}

function App() {
  return (
    <HashRouter>
      <AppContent />
    </HashRouter>
  );
}

export { App };
