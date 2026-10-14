import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useState } from "react";
import { resolveTraceImageUrl } from "../lib/attachmentImages";

export function TraceImage({ url, alt }: { url: string; alt: string }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const src = resolveTraceImageUrl(url);
  if (!src || failedUrl === url) {
    return <span className="text-[10px] text-muted-foreground">Image unavailable</span>;
  }
  return (
    <Dialog.Root key={url}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label={`Enlarge image: ${alt}`}
          title="Click to enlarge"
          className="inline-flex max-w-full cursor-zoom-in rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <img
            src={src}
            alt={alt}
            className="max-h-56 max-w-full rounded object-contain"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailedUrl(url)}
          />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-[1600px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-md border border-border bg-background shadow-xl outline-none">
          <div className="flex h-12 items-center justify-between border-b border-border px-4">
            <Dialog.Title className="text-sm font-semibold">Image preview</Dialog.Title>
            <Dialog.Description className="sr-only">{alt}</Dialog.Description>
            <Dialog.Close
              aria-label="Close image preview"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <div className="flex items-center justify-center bg-black/20 p-3">
            <img
              src={src}
              alt={alt}
              className="max-h-[calc(100dvh-8rem)] max-w-full object-contain"
              referrerPolicy="no-referrer"
              onError={() => setFailedUrl(url)}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
