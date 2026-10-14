import { useState } from "react";
import { resolveTraceImageUrl } from "../lib/attachmentImages";

export function TraceImage({ url, alt }: { url: string; alt: string }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const src = resolveTraceImageUrl(url);
  if (!src || failedUrl === url) {
    return <span className="text-[10px] text-muted-foreground">Image unavailable</span>;
  }
  return (
    <img
      src={src}
      alt={alt}
      className="max-h-56 max-w-full rounded object-contain"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailedUrl(url)}
    />
  );
}
