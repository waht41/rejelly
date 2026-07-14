/**
 * Unknown URL: keep the address bar unchanged so typos and broken links stay visible.
 */
import { Link, useLocation } from "react-router-dom";

export function NotFoundPage() {
  const location = useLocation();

  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground max-w-md leading-relaxed">
        No view matches this path. The URL is left as-is so you can fix a typo or compare it with a
        working link.
      </p>
      <p
        className="text-xs font-mono text-muted-foreground break-all max-w-lg"
        title={location.pathname + location.search}
      >
        {location.pathname}
        {location.search}
      </p>
      <Link
        to="/trace/detail"
        className="text-sm rounded-md border border-border px-4 py-2 hover:bg-muted transition-colors"
      >
        Back to trace detail
      </Link>
    </div>
  );
}
