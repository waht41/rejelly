import { toast } from "@shared/hooks/use-toast";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface CopyButtonProps {
  value: string;
  label: string;
}

export function CopyButton({ value, label }: CopyButtonProps) {
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const copied = copiedValue === value;
  const [copying, setCopying] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copy = async () => {
    setCopying(true);
    try {
      await navigator.clipboard.writeText(value);
      clearTimeout(resetTimer.current);
      setCopiedValue(value);
      resetTimer.current = setTimeout(() => setCopiedValue(null), 2000);
    } catch {
      toast({
        title: "Copy failed",
        description: "Could not access the clipboard. Select the text and copy it manually.",
        variant: "destructive",
      });
    } finally {
      setCopying(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      disabled={copying}
      aria-label={label}
      title={label}
      className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] font-normal text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
    >
      {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </button>
  );
}
