/**
 * Generation Detail View Component
 *
 * Main component with Tab-based progressive disclosure
 */

import { selectBudgetSummaryForSpan } from "@entities/trace/lib/budgetSelectors.ts";
import { JsonViewer } from "@shared/ui/JsonViewer";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@shared/ui/tabs.tsx";
import { BudgetTab } from "@widgets/trace-inspector/ui/BudgetTab";
import { useMemo, useState } from "react";
import type { NormalizedTrace } from "src/entities/trace/types";
import { ExecutionTab } from "./ExecutionTab";
import { OverviewTab } from "./OverviewTab";
import { ToolsTab } from "./ToolsTab";

interface GenerationDetailViewProps {
  trace: NormalizedTrace.Trace;
  hostSpanId: string;
  agent: NormalizedTrace.AgentNode;
  generation: NormalizedTrace.GenerationNode;
}

export function GenerationDetailView({
  trace,
  hostSpanId,
  agent,
  generation,
}: GenerationDetailViewProps) {
  const [activeTab, setActiveTab] = useState("overview");

  const rawData = useMemo(
    () => ({
      generation,
      agent: {
        spanId: agent.spanId,
        name: agent.name,
        agentId: agent.startEvent.agentId,
      },
    }),
    [generation, agent],
  );

  const budgetSummary = useMemo(
    () => selectBudgetSummaryForSpan(trace, generation.spanId),
    [trace, generation.spanId],
  );

  const genNum = generation.startEvent.generationId;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-border flex-shrink-0">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Generation Details
          </h2>
          <div className="text-[10px] text-muted-foreground">
            Gen {genNum} - {agent.name}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
        <TabsList className="w-full justify-start rounded-none border-b border-border bg-muted/30">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="budget">Budget</TabsTrigger>
          <TabsTrigger value="execution">Execution</TabsTrigger>
          <TabsTrigger value="raw">Raw JSON</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex-1 min-h-0 mt-0">
          <OverviewTab trace={trace} hostSpanId={hostSpanId} generation={generation} />
        </TabsContent>

        <TabsContent value="tools" className="flex-1 min-h-0 mt-0">
          <ToolsTab generation={generation} />
        </TabsContent>

        <TabsContent value="budget" className="flex-1 min-h-0 mt-0">
          <BudgetTab summary={budgetSummary} />
        </TabsContent>

        <TabsContent value="execution" className="flex-1 min-h-0 mt-0">
          <ExecutionTab trace={trace} generation={generation} />
        </TabsContent>

        <TabsContent value="raw" className="flex-1 min-h-0 mt-0">
          <JsonViewer data={rawData} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
