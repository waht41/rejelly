/**
 * Container for RunWith detail view (NormalizedTrace.RunWithNode + inspector).
 */

import { useTraceStore } from "@entities/trace/store";
import { RunWithInspector } from "@widgets/trace-inspector/run-with-detail/RunWithInspector.tsx";

interface RunWithDetailContainerProps {
  nodeId: string;
}

export function RunWithDetailContainer({ nodeId }: RunWithDetailContainerProps) {
  const normalizedTrace = useTraceStore((state) => state.normalizedTrace);

  if (!normalizedTrace) return null;
  const n = normalizedTrace.nodeMap[nodeId];
  if (!n || n.type !== "runWith") return null;

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0">
        <RunWithInspector trace={normalizedTrace} runWith={n} />
      </div>
    </div>
  );
}
