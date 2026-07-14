/**
 * Collapsible schema block with TS / JSON Schema toggle (shared by Overview, Tools tab, etc.).
 */

import { formatSchemaForDisplay, type SchemaViewMode } from "@shared/lib/schemaDisplay";
import { AutoHeightEditor, MAX_EDITOR_HEIGHT } from "@shared/ui/AutoHeightEditor";
import { CollapsibleSection } from "@shared/ui/CollapsibleSection";
import { useMemo, useState } from "react";

export function SchemaViewModeToggle({
  viewMode,
  setViewMode,
}: {
  viewMode: SchemaViewMode;
  setViewMode: (m: SchemaViewMode) => void;
}) {
  return (
    <div className="flex rounded border border-border/60 bg-background/80 overflow-hidden text-[10px]">
      <button
        type="button"
        className={`px-2 py-1 ${viewMode === "ts" ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground"}`}
        onClick={() => setViewMode("ts")}
      >
        TS Interface
      </button>
      <button
        type="button"
        className={`px-2 py-1 ${viewMode === "json" ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground"}`}
        onClick={() => setViewMode("json")}
      >
        JSON Schema
      </button>
    </div>
  );
}

export interface SchemaSectionProps {
  schema?: unknown;
  /** Section title (default: SCHEMA) */
  title?: string;
}

export function SchemaSection({ schema, title = "SCHEMA" }: SchemaSectionProps) {
  const [viewMode, setViewMode] = useState<SchemaViewMode>("ts");
  const displayValue = useMemo(() => formatSchemaForDisplay(schema, viewMode), [schema, viewMode]);

  if (schema === undefined) return null;

  return (
    <CollapsibleSection
      title={title}
      rightContent={<SchemaViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />}
    >
      <AutoHeightEditor
        value={displayValue}
        language={viewMode === "ts" ? "typescript" : "json"}
        maxHeight={Math.min(320, MAX_EDITOR_HEIGHT)}
      />
    </CollapsibleSection>
  );
}
