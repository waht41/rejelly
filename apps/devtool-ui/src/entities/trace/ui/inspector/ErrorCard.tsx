import type { ErrorInfo } from "@entities/trace/types";
import { CopyButton } from "@shared/ui/CopyButton";
import { useState } from "react";
import { Inspector } from "./index";

interface ErrorCardProps {
  error: ErrorInfo;
}

function formatError(error: ErrorInfo): string {
  // Keep the message even when a producer's stack does not include it.
  const message = `${error.name}: ${error.message}`;
  const parts = [message];
  if (error.stack) parts.push(error.stack);
  if (error.cause) parts.push(`Caused by: ${formatError(error.cause)}`);
  return parts.join("\n\n");
}

export function ErrorDetailsSection({ error }: ErrorCardProps) {
  return (
    <Inspector.Section
      title="ERROR DETAILS"
      variant="error"
      actions={<CopyButton value={formatError(error)} label="Copy error" />}
    >
      <ErrorCard error={error} />
    </Inspector.Section>
  );
}

export function ErrorCard({ error }: ErrorCardProps) {
  const [wrapLines, setWrapLines] = useState(true);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div>
        <div className="mb-1 break-words text-xs font-semibold text-red-400">{error.name}</div>
        <div className="whitespace-pre-wrap break-words text-[11px] text-red-300 [overflow-wrap:anywhere]">
          {error.message}
        </div>
      </div>
      {error.stack && (
        <div className="mt-2 min-w-0">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[10px] font-semibold text-muted-foreground">Stack Trace:</div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={wrapLines}
                  onChange={(event) => setWrapLines(event.target.checked)}
                />
                Wrap lines
              </label>
              <CopyButton value={error.stack} label="Copy stack" />
            </div>
          </div>
          <pre
            className={`max-h-96 overflow-auto rounded bg-red-500/5 p-2 font-mono text-[10px] text-red-300 ${
              wrapLines ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"
            }`}
            tabIndex={0}
            aria-label="Stack trace"
          >
            {error.stack}
          </pre>
        </div>
      )}
      {error.cause && (
        <div className="mt-2 min-w-0 border-t border-red-500/20 pt-2">
          <div className="mb-1 text-[10px] font-semibold text-muted-foreground">Caused by:</div>
          <ErrorCard error={error.cause} />
        </div>
      )}
    </div>
  );
}
