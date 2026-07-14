/**
 * /trace/:traceId without a view suffix → canonical detail URL (preserves trace id).
 */
import { Navigate, useParams } from "react-router-dom";

export function TraceRootRedirect() {
  const { traceId } = useParams<{ traceId: string }>();
  if (!traceId) {
    return <Navigate to="/" replace />;
  }

  return <Navigate to={`/trace/${encodeURIComponent(traceId)}/detail`} replace />;
}
