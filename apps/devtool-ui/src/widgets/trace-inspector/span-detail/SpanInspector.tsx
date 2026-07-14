/**
 * Span Inspector Component
 *
 * Displays span details including attributes, metadata, and error information
 */

import { selectBudgetSummaryForSpan } from "@entities/trace/lib/budgetSelectors.ts";
import type { NormalizedTrace } from "@entities/trace/types";
import { Inspector } from "@entities/trace/ui/inspector";
import { ErrorCard } from "@entities/trace/ui/inspector/ErrorCard.tsx";
import { StatusBadge } from "@entities/trace/ui/StatusBadge.tsx";
import { formatDuration } from "@shared/lib/formatters.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@shared/ui/tabs";
import { BudgetTab } from "@widgets/trace-inspector/ui/BudgetTab";
import { Clock, Code } from "lucide-react";
import { useMemo, useState } from "react";

interface SpanInspectorProps {
  trace: NormalizedTrace.Trace;
  span: NormalizedTrace.SpanNode;
}

export function SpanInspector({ trace, span }: SpanInspectorProps) {
  const [activeTab, setActiveTab] = useState("overview");
  const budgetSummary = useMemo(
    () => selectBudgetSummaryForSpan(trace, span.spanId),
    [trace, span.spanId],
  );

  const formatValue = (value: unknown): string => {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "string") return value;
    if (typeof value === "object") {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }
    return String(value);
  };

  const getValueType = (value: unknown): string => {
    if (value === null) return "null";
    if (Array.isArray(value)) return "Array";
    return typeof value === "object" ? "Object" : typeof value;
  };

  // End event's trace carries the final attributes (static + values added via
  // span.setAttribute); fall back to the start event's trace while still running.
  const attributes = (span.endEvent ?? span.startEvent).trace.attributes ?? {};

  return (
    <Inspector.Root>
      <Inspector.Header
        icon={<Code className="w-4 h-4 text-purple-400" />}
        title={span.name}
        status={<StatusBadge status={span.status} />}
        metaItems={[
          {
            icon: <Clock className="w-3 h-3" />,
            label: "Duration: ",
            value: formatDuration(span.duration),
          },
          { icon: <span>🆔</span>, label: "", value: span.spanId },
          { label: "TYPE: ", value: "CUSTOM_SPAN" },
        ]}
      />

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
        <TabsList className="w-full justify-start rounded-none border-b border-border bg-muted/30">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="budget">Budget</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex-1 min-h-0 mt-0">
          <Inspector.Content>
            {/* Attributes Section */}
            {Object.keys(attributes).length > 0 ? (
              <Inspector.Section
                title="ATTRIBUTES (User Data)"
                description="Custom attributes set via span.setAttribute()"
                contentClassName="p-0"
              >
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border bg-muted/20">
                        <th className="text-left p-2 font-semibold text-foreground">Key</th>
                        <th className="text-left p-2 font-semibold text-foreground">Value</th>
                        <th className="text-left p-2 font-semibold text-foreground">Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(attributes).map(([key, value]) => (
                        <tr key={key} className="border-b border-border/50 hover:bg-muted/20">
                          <td className="p-2 font-mono text-[11px] text-blue-400">{key}</td>
                          <td className="p-2 font-mono text-[11px] text-foreground max-w-md truncate">
                            {formatValue(value)}
                          </td>
                          <td className="p-2 text-[10px] text-muted-foreground">
                            {getValueType(value)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Inspector.Section>
            ) : (
              <Inspector.EmptySection message="No attributes set. Use span.setAttribute() to add custom data." />
            )}

            {/* Error Details */}
            {span.endEvent?.error && (
              <Inspector.Section title="ERROR DETAILS" variant="error">
                <ErrorCard error={span.endEvent.error} />
              </Inspector.Section>
            )}
          </Inspector.Content>
        </TabsContent>

        <TabsContent value="budget" className="flex-1 min-h-0 mt-0">
          <BudgetTab summary={budgetSummary} />
        </TabsContent>
      </Tabs>
    </Inspector.Root>
  );
}
