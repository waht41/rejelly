/**
 * Overview Tab Component
 *
 * Displays Input/Props, Memory Diff, and Output/Result.
 * Equipped tool names only — full tool definitions are on the Tools tab.
 */

import { ErrorCard } from "@entities/trace/ui/inspector/ErrorCard";
import { AutoHeightDiffEditor, AutoHeightEditor } from "@shared/ui/AutoHeightEditor";
import { CollapsibleSection } from "@shared/ui/CollapsibleSection";
import { SchemaSection } from "@shared/ui/SchemaSection";
import {
  collectUpdateEventsForGeneration,
  selectExecutionReplayForAgentGeneration,
  selectMemoryDiffForGeneration,
  selectOutputValidationFromGenerationEnd,
} from "@widgets/trace-inspector/lib/generationViewModel";
import type { ErrorInfo, NormalizedTrace } from "src/entities/trace/types";

interface OverviewTabProps {
  trace: NormalizedTrace.Trace;
  hostSpanId: string;
  generation: NormalizedTrace.GenerationNode;
}

function InputSection({ input }: { input?: unknown }) {
  if (input === undefined) return null;
  return (
    <CollapsibleSection title="INPUT (PROPS)">
      <AutoHeightEditor value={JSON.stringify(input, null, 2)} />
    </CollapsibleSection>
  );
}

function MemoryDiffSection({
  diff,
}: {
  diff?: { description?: string; prevMemory?: string; currentMemory?: string };
}) {
  if (!diff) return null;
  return (
    <CollapsibleSection title="MEMORY STATE (DIFF)" description={diff.description}>
      <AutoHeightDiffEditor original={diff.prevMemory ?? ""} modified={diff.currentMemory ?? ""} />
    </CollapsibleSection>
  );
}

/** Tool identifiers only — details on Tools tab */
function ToolNamesSection({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <CollapsibleSection title="TOOLS (NAMES)">
      <div className="px-3 py-2 text-xs font-mono text-muted-foreground flex flex-wrap gap-x-3 gap-y-1.5 leading-relaxed">
        {names.map((name) => (
          <span key={name} className="text-foreground/85">
            {name}
          </span>
        ))}
      </div>
    </CollapsibleSection>
  );
}

function OutputSection({
  outputValidation,
}: {
  outputValidation?: { data?: unknown; raw?: string };
}) {
  if (!outputValidation) return null;
  const value =
    outputValidation.data !== undefined
      ? JSON.stringify(outputValidation.data, null, 2)
      : (outputValidation.raw ?? "");
  return (
    <CollapsibleSection title="OUTPUT (RESULT)">
      <AutoHeightEditor value={value} />
    </CollapsibleSection>
  );
}

function ErrorSection({ error }: { error?: ErrorInfo }) {
  if (!error) return null;
  return (
    <div className="border-b border-border">
      <div className="bg-muted/30 px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
        ERROR
      </div>
      <div className="p-3">
        <ErrorCard error={error} />
      </div>
    </div>
  );
}

export function OverviewTab({ trace, hostSpanId, generation }: OverviewTabProps) {
  const end = generation.endEvent;
  const updateEvents = collectUpdateEventsForGeneration(trace, generation);
  const replay = selectExecutionReplayForAgentGeneration(trace, generation, updateEvents);

  const input = generation.startEvent.props;
  const schema = replay?.schema;
  const toolNames = end?.draft?.tools?.map((t) => t.name) ?? [];
  const memoryDiff = end
    ? selectMemoryDiffForGeneration(trace, hostSpanId, generation, end)
    : undefined;
  const outputValidation = end ? selectOutputValidationFromGenerationEnd(end) : undefined;
  const error = end?.error as ErrorInfo | undefined;

  const isEmpty =
    !input && !schema && !memoryDiff && !outputValidation && !error && toolNames.length === 0;

  if (isEmpty) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        No overview data available
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background custom-scrollbar">
      <InputSection input={input} />
      <SchemaSection schema={schema} />
      <ToolNamesSection names={toolNames} />
      <MemoryDiffSection diff={memoryDiff} />
      <OutputSection outputValidation={outputValidation} />
      <ErrorSection error={error} />
    </div>
  );
}
