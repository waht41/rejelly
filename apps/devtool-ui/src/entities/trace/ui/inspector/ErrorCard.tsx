import type { ErrorInfo } from "src/entities/trace/types";

interface ErrorCardProps {
  error: ErrorInfo;
}

export function ErrorCard({ error }: ErrorCardProps) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="text-xs font-semibold text-red-400 mb-1">{error.name}</div>
        <div className="text-[11px] text-red-300">{error.message}</div>
      </div>
      {error.stack && (
        <div className="mt-2">
          <div className="text-[10px] font-semibold text-muted-foreground mb-1">Stack Trace:</div>
          <pre className="text-[10px] font-mono text-red-300 bg-red-500/5 p-2 rounded overflow-x-auto whitespace-pre-wrap">
            {error.stack}
          </pre>
        </div>
      )}
      {error.cause && (
        <div className="mt-2 border-t border-red-500/20 pt-2">
          <div className="text-[10px] font-semibold text-muted-foreground mb-1">Caused by:</div>
          <ErrorCard error={error.cause} />
        </div>
      )}
    </div>
  );
}
