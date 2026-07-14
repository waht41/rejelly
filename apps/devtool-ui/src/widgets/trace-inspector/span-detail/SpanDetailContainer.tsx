/**
 * Container for Span detail view (NormalizedTrace.SpanNode + inspector).
 */

import { useTraceStore } from "@entities/trace/store";
import { TimelineHeader } from "@widgets/trace-inspector/header/TimelineHeader.tsx";
import { SpanInspector } from "@widgets/trace-inspector/span-detail/SpanInspector.tsx";

interface SpanDetailContainerProps {
  nodeId: string;
}

export function SpanDetailContainer({ nodeId }: SpanDetailContainerProps) {
  const normalizedTrace = useTraceStore((state) => state.normalizedTrace);

  if (!normalizedTrace) return null;
  const n = normalizedTrace.nodeMap[nodeId];
  if (!n || n.type !== "span") return null;

  return (
    <div className="h-full flex flex-col">
      <TimelineHeader agent={null} trace={null} />
      <div className="flex-1 min-h-0">
        <SpanInspector trace={normalizedTrace} span={n} />
      </div>
    </div>
  );
}
