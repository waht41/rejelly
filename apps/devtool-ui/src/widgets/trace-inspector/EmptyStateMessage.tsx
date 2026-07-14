/**
 * Empty state placeholder for detail view
 */

interface EmptyStateMessageProps {
  message: string;
}

export function EmptyStateMessage({ message }: EmptyStateMessageProps) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        {message}
      </div>
    </div>
  );
}
