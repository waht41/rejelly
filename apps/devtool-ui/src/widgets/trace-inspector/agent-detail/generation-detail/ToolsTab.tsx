/**
 * Tools Tab — full equipped tool list (description, middlewares, parameters schema).
 * Heavy content lives here so Overview stays compact when many tools exist.
 */

import {
  formatSchemaForDisplay,
  type SchemaViewMode,
  tsInterfaceNameForTool,
} from "@shared/lib/schemaDisplay";
import { AutoHeightEditor, MAX_EDITOR_HEIGHT } from "@shared/ui/AutoHeightEditor";
import { CollapsibleSection } from "@shared/ui/CollapsibleSection";
import { SchemaViewModeToggle } from "@shared/ui/SchemaSection";
import { useState } from "react";
import type { NormalizedTrace } from "src/entities/trace/types";

interface ToolsTabProps {
  generation: NormalizedTrace.GenerationNode;
}

export function ToolsTab({ generation }: ToolsTabProps) {
  const tools = generation.endEvent?.draft?.tools;
  const [viewMode, setViewMode] = useState<SchemaViewMode>("ts");

  if (!tools || tools.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm px-4 text-center">
        No equipped tools in this generation snapshot
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background custom-scrollbar">
      <CollapsibleSection
        title={`TOOLS (${tools.length})`}
        rightContent={<SchemaViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />}
      >
        <div className="space-y-4">
          {tools.map((tool) => {
            const iface = tsInterfaceNameForTool(tool.name);
            const displayValue = formatSchemaForDisplay(tool.parameters, viewMode, iface);
            return (
              <div
                key={tool.name}
                className="rounded border border-border/60 bg-muted/20 overflow-hidden"
              >
                <div className="px-3 py-2 border-b border-border/50 bg-muted/30">
                  <div className="text-sm text-foreground/90 leading-relaxed">{tool.name}</div>
                  {tool.description ? (
                    <p className="text-xs font-semibold text-foreground mt-1.5">
                      {tool.description}
                    </p>
                  ) : null}
                  {tool.middlewares && tool.middlewares.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {tool.middlewares.map((m, mi) => (
                        <span
                          key={`${tool.name}-mw-${mi}-${m.name}`}
                          className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] bg-background/80 border border-border/60 text-muted-foreground"
                          title={m.config ? JSON.stringify(m.config) : undefined}
                        >
                          {m.name}
                          {m.config && Object.keys(m.config).length > 0 ? " · cfg" : ""}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <AutoHeightEditor
                  value={displayValue}
                  language={viewMode === "ts" ? "typescript" : "json"}
                  maxHeight={Math.min(320, MAX_EDITOR_HEIGHT)}
                />
              </div>
            );
          })}
        </div>
      </CollapsibleSection>
    </div>
  );
}
