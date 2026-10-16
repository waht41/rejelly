import { Editor } from "@monaco-editor/react";
import * as Dialog from "@radix-ui/react-dialog";
import { CopyButton } from "@shared/ui/CopyButton";
import { ChevronDown, ChevronRight, Maximize2, X } from "lucide-react";
import { useId, useMemo, useState } from "react";

function formatValue(value: unknown): string {
  if (value !== null && typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function getValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "Array";
  return typeof value === "object" ? "Object" : typeof value;
}

function AttributeDetails({
  name,
  text,
  structured,
}: {
  name: string;
  text: string;
  structured: boolean;
}) {
  const [wrapLines, setWrapLines] = useState(true);
  const [largeView, setLargeView] = useState(false);
  const editor = (
    <Editor
      height="100%"
      language={structured ? "json" : "plaintext"}
      value={text}
      theme="vs-dark"
      options={{
        readOnly: true,
        domReadOnly: true,
        fontSize: 12,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: wrapLines ? "on" : "off",
        automaticLayout: true,
        folding: structured,
        showFoldingControls: "always",
      }}
    />
  );
  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <label className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          checked={wrapLines}
          onChange={(event) => setWrapLines(event.target.checked)}
        />
        Wrap lines
      </label>
      <CopyButton value={text} label={structured ? "Copy JSON" : "Copy value"} />
    </div>
  );

  return (
    <Dialog.Root open={largeView} onOpenChange={setLargeView}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        {controls}
        <Dialog.Trigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Maximize2 className="h-3 w-3" />
            Open large view
          </button>
        </Dialog.Trigger>
      </div>
      <div className="h-72 min-w-0 overflow-hidden rounded border border-border">
        {!largeView && editor}
      </div>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="fixed inset-4 z-50 flex min-h-0 min-w-0 flex-col rounded-md border border-border bg-background shadow-xl">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border p-3">
            <Dialog.Title className="min-w-0 break-all text-sm font-semibold">{name}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close large view"
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            Full attribute value. JSON nodes can be folded using the editor gutter.
          </Dialog.Description>
          <div className="shrink-0 p-2">{controls}</div>
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{editor}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AttributeRow({ name, value }: { name: string; value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const text = useMemo(() => formatValue(value), [value]);
  const structured = value !== null && typeof value === "object";
  const type = getValueType(value);

  return (
    <>
      <tr className="border-b border-border/50 hover:bg-muted/20">
        <td className="p-2 align-top font-mono text-[11px] text-blue-400 break-all">{name}</td>
        <td className="p-2 align-top">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${name}`}
            onClick={() => setExpanded((current) => !current)}
            className="flex w-full min-w-0 items-center gap-1 rounded text-left font-mono text-[11px] hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">
              {structured ? `${type} · ` : ""}
              {text.replace(/\s+/g, " ")}
            </span>
            <span className="shrink-0 font-sans text-muted-foreground">
              {expanded ? "Collapse" : "Expand"}
            </span>
          </button>
        </td>
        <td className="p-2 align-top text-[10px] text-muted-foreground">{type}</td>
        <td className="p-1 align-top text-right">
          <CopyButton value={text} label="Copy value" />
        </td>
      </tr>
      <tr hidden={!expanded} className="border-b border-border/50 bg-muted/10">
        <td colSpan={4} className="p-3">
          <div id={detailsId}>
            {expanded && <AttributeDetails name={name} text={text} structured={structured} />}
          </div>
        </td>
      </tr>
    </>
  );
}

export function TraceAttributesTable({ attributes }: { attributes: Record<string, unknown> }) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full min-w-[480px] table-fixed text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/20">
            <th className="w-1/5 p-2 text-left font-semibold">Key</th>
            <th className="p-2 text-left font-semibold">Value</th>
            <th className="w-20 p-2 text-left font-semibold">Type</th>
            <th className="w-32 p-2 text-right font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(attributes).map(([name, value]) => (
            <AttributeRow key={name} name={name} value={value} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
