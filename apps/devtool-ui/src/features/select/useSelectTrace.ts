/**
 * Trace Actions Hook
 *
 * User-initiated actions only (e.g. selectTrace). No passive event handlers here.
 * Overview/new-trace handling lives in useAppWebSocket (singleton seenTraceIds).
 */

import { buildTracePath } from "@entities/route/routeUtils.ts";
import { useCallback } from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";

/**
 * Hook that provides trace-related user actions (routing side effects).
 */
export function useSelectTrace() {
  const navigate = useNavigate();
  const location = useLocation();
  const mode = matchPath("/trace/:traceId?/waterfall", location.pathname) ? "waterfall" : "detail";

  /** Select a trace by navigating to current route mode path */
  const selectTrace = useCallback(
    (traceId: string) => {
      navigate(buildTracePath(traceId, mode));
    },
    [mode, navigate],
  );

  return {
    selectTrace,
  };
}
