/**
 * Toast utility for Trace notifications
 *
 * Provides IDE-style toast notifications for trace events
 */

import { Network } from "lucide-react";
import { toast } from "../../../shared/hooks/use-toast";
import { ToastAction } from "../../../shared/ui/toast";

interface ToastTraceOptions {
  traceId: string;
  onViewDetails?: () => void;
  duration?: number;
}

/**
 * Show a toast notification for a new trace
 *
 * @param options - Toast configuration options
 * @returns Toast instance with dismiss/update methods
 */
export function toastTrace(options: ToastTraceOptions) {
  const { traceId, onViewDetails, duration = 10_000 } = options;

  return toast({
    className: "bg-zinc-900 border-zinc-800 border-l-4 border-l-blue-500",
    title: (
      <div className="flex items-center gap-2">
        <Network className="h-4 w-4 text-blue-500" />
        <span>New Trace Captured</span>
      </div>
    ),
    description: (
      <div className="mt-1 flex flex-col gap-1">
        <p className="font-mono text-xs text-zinc-400">ID: {traceId.slice(0, 8)}...</p>
        {onViewDetails && (
          <div className="flex items-center gap-2 mt-1">
            <ToastAction
              altText="View trace details"
              onClick={onViewDetails}
              className="text-xs bg-zinc-800 hover:bg-zinc-700 px-2 py-1 rounded text-white transition-colors"
            >
              View Details
            </ToastAction>
          </div>
        )}
      </div>
    ),
    duration,
  });
}
