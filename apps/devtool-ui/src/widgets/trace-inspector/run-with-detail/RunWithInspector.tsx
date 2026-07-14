/**
 * RunWith Inspector Component
 *
 * Displays runWith details including props, result, configuration, and error information
 */

import { selectBudgetSummaryForSpan } from "@entities/trace/lib/budgetSelectors.ts";
import type { ErrorInfo, NormalizedTrace } from "@entities/trace/types";
import { Inspector } from "@entities/trace/ui/inspector";
import { ErrorCard } from "@entities/trace/ui/inspector/ErrorCard.tsx";
import { StatusBadge } from "@entities/trace/ui/StatusBadge.tsx";
import type { RunWithEndEvent } from "@rejelly/core";
import { formatDuration } from "@shared/lib/formatters.ts";
import { AutoHeightEditorSection } from "@shared/ui/AutoHeightEditor.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@shared/ui/tabs";
import { BudgetTab } from "@widgets/trace-inspector/ui/BudgetTab";
import { Clock, Play } from "lucide-react";
import { useMemo, useState } from "react";

interface RunWithInspectorProps {
  trace: NormalizedTrace.Trace;
  runWith: NormalizedTrace.RunWithNode;
}

type RunWithStart = NormalizedTrace.RunWithNode["startEvent"];

function getRestorationAttributes(
  event: RunWithStart | NormalizedTrace.RunWithNode["endEvent"] | undefined,
): Record<string, unknown> {
  const attributes = event?.trace.attributes;
  if (!attributes) return {};

  return Object.fromEntries(
    Object.entries(attributes)
      .filter(([key]) => key.startsWith("restoration."))
      .map(([key, value]) => [key.slice("restoration.".length), value]),
  );
}

function formatAttributeValue(value: unknown): string {
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
}

function getAttributeValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "Array";
  return typeof value === "object" ? "Object" : typeof value;
}

/** Metrics / metadata derived from runWith:end (same rules as former legacy adapter). */
function deriveRunWithEndFields(end: NormalizedTrace.RunWithNode["endEvent"]): {
  metrics?: {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    costs?: Record<string, number>;
  };
  metadata: Record<string, unknown>;
} {
  if (!end) {
    return { metadata: {} };
  }
  const endPayload = end as RunWithEndEvent & Record<string, unknown>;

  let metrics:
    | {
        totalPromptTokens: number;
        totalCompletionTokens: number;
        totalTokens: number;
        costs?: Record<string, number>;
      }
    | undefined;
  if (end.metrics && typeof end.metrics === "object") {
    const m = end.metrics;
    const costsRaw = m.costs;
    const costs =
      costsRaw && typeof costsRaw === "object" && !Array.isArray(costsRaw)
        ? (costsRaw as Record<string, number>)
        : undefined;
    metrics = {
      totalPromptTokens: Number(m.totalPromptTokens) || 0,
      totalCompletionTokens: Number(m.totalCompletionTokens) || 0,
      totalTokens: Number(m.totalTokens) || 0,
      ...(costs !== undefined && Object.keys(costs).length > 0 ? { costs } : {}),
    };
  }

  const metadata =
    endPayload.metadata && typeof endPayload.metadata === "object"
      ? (endPayload.metadata as Record<string, unknown>)
      : {};

  return { metrics, metadata };
}

function RunWithConfigurationSection({ start }: { start: RunWithStart }) {
  return (
    <Inspector.Section title="CONFIGURATION" description="RunWith execution configuration">
      <div className="flex items-center justify-between p-2 bg-muted/10 rounded border border-border/50">
        <span className="text-xs font-medium">Environment</span>
        <span
          className={`text-[10px] ${start.config.isProd ? "text-amber-400" : "text-muted-foreground"}`}
        >
          {start.config.isProd ? "Production" : "Development"}
        </span>
      </div>
      <div className="flex items-center justify-between p-2 bg-muted/10 rounded border border-border/50">
        <span className="text-xs font-medium">Snapshot enabled</span>
        <span
          className={`text-[10px] ${start.config.enableSnapshot ? "text-green-400" : "text-muted-foreground"}`}
        >
          {start.config.enableSnapshot ? "✓ Yes" : "✗ No"}
        </span>
      </div>
      <div className="flex items-center justify-between p-2 bg-muted/10 rounded border border-border/50">
        <span className="text-xs font-medium">EventBus</span>
        <span
          className={`text-[10px] ${start.dependencies.hasEventBus ? "text-green-400" : "text-muted-foreground"}`}
        >
          {start.dependencies.hasEventBus ? "✓ Yes" : "✗ No"}
        </span>
      </div>
      {start.dependencies.registeredModels.length > 0 && (
        <div className="flex items-center justify-between p-2 bg-muted/10 rounded border border-border/50">
          <span className="text-xs font-medium">Registered models</span>
          <span className="text-[10px] text-muted-foreground font-mono">
            {start.dependencies.registeredModels.join(", ")}
          </span>
        </div>
      )}
    </Inspector.Section>
  );
}

function RunWithAttributesSection({ attributes }: { attributes: Record<string, unknown> }) {
  if (Object.keys(attributes).length === 0) {
    return null;
  }

  return (
    <Inspector.Section
      title="ATTRIBUTES"
      description="Trace attributes attached to this runWith span"
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
                  {formatAttributeValue(value)}
                </td>
                <td className="p-2 text-[10px] text-muted-foreground">
                  {getAttributeValueType(value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Inspector.Section>
  );
}

function RunWithRestorationSection({
  restoration,
  attributes,
}: {
  restoration: NonNullable<RunWithStart["restoration"]>;
  attributes: Record<string, unknown>;
}) {
  return (
    <Inspector.Section title="RESTORATION" description="Time-travel snapshot provenance">
      <div className="flex items-center justify-between p-2 bg-muted/10 rounded border border-border/50">
        <span className="text-xs font-medium">Restored from snapshot</span>
        <span className="text-[10px] text-green-400">✓ Yes</span>
      </div>
      <div className="flex items-center justify-between p-2 bg-muted/10 rounded border border-border/50">
        <span className="text-xs font-medium">Source process ID</span>
        <span className="text-[10px] text-muted-foreground font-mono">
          {restoration.sourceProcessId || "—"}
        </span>
      </div>
      <div className="flex items-center justify-between p-2 bg-muted/10 rounded border border-border/50">
        <span className="text-xs font-medium">Snapshot timestamp</span>
        <span className="text-[10px] text-muted-foreground font-mono">
          {restoration.snapshotTimestamp
            ? new Date(restoration.snapshotTimestamp).toISOString()
            : "—"}
        </span>
      </div>
      <div className="flex items-center justify-between p-2 bg-muted/10 rounded border border-border/50">
        <span className="text-xs font-medium">Snapshot version</span>
        <span className="text-[10px] text-muted-foreground font-mono">
          {restoration.snapshotVersion || "—"}
        </span>
      </div>
      {restoration.provenance && (
        <>
          <div className="flex items-center justify-between p-2 bg-muted/10 rounded border border-border/50">
            <span className="text-xs font-medium">Provenance traceId</span>
            <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[180px]">
              {restoration.provenance.traceId || "—"}
            </span>
          </div>
          {(restoration.provenance.spanId ??
            restoration.provenance.anchor ??
            restoration.provenance.source) && (
            <div className="flex items-center justify-between p-2 bg-muted/10 rounded border border-border/50">
              <span className="text-xs font-medium">Provenance span / anchor / source</span>
              <span className="text-[10px] text-muted-foreground font-mono">
                {[
                  restoration.provenance.spanId,
                  restoration.provenance.anchor,
                  restoration.provenance.source,
                ]
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </span>
            </div>
          )}
        </>
      )}
      {Object.keys(attributes).length > 0 && (
        <div className="p-2 bg-muted/10 rounded border border-border/50">
          <span className="text-xs font-medium">Snapshot metadata</span>
          <pre className="text-[10px] text-muted-foreground font-mono mt-1 overflow-auto max-h-24">
            {JSON.stringify(attributes, null, 2)}
          </pre>
        </div>
      )}
    </Inspector.Section>
  );
}

function RunWithGlobalMetricsSection({
  metrics,
}: {
  metrics: NonNullable<ReturnType<typeof deriveRunWithEndFields>["metrics"]>;
}) {
  return (
    <Inspector.Section title="GLOBAL METRICS" description="Aggregate token and cost for this run">
      <div className="flex items-center justify-between p-2 bg-muted/10 rounded border border-border/50">
        <span className="text-xs font-medium">Total tokens</span>
        <span className="text-[10px] font-mono">{metrics.totalTokens}</span>
      </div>
      <div className="flex items-center justify-between p-2 bg-muted/10 rounded border border-border/50">
        <span className="text-xs font-medium">Prompt / Completion</span>
        <span className="text-[10px] font-mono">
          {metrics.totalPromptTokens} / {metrics.totalCompletionTokens}
        </span>
      </div>
      {metrics.costs && Object.keys(metrics.costs).length > 0 && (
        <div className="flex flex-col gap-1 p-2 bg-muted/10 rounded border border-border/50">
          <span className="text-xs font-medium">Costs (integer units)</span>
          {Object.entries(metrics.costs).map(([unit, value]) => (
            <div key={unit} className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">{unit}</span>
              <span className="text-[10px] font-mono">{value}</span>
            </div>
          ))}
        </div>
      )}
    </Inspector.Section>
  );
}

export function RunWithInspector({ trace, runWith }: RunWithInspectorProps) {
  const [activeTab, setActiveTab] = useState("overview");
  const start = runWith.startEvent;
  const end = runWith.endEvent;
  const { metrics, metadata } = deriveRunWithEndFields(end);
  const attributes = (end ?? start).trace.attributes ?? {};
  const restorationAttributes = getRestorationAttributes(end ?? start);
  const budgetSummary = useMemo(
    () => selectBudgetSummaryForSpan(trace, runWith.spanId),
    [trace, runWith.spanId],
  );

  return (
    <Inspector.Root>
      <Inspector.Header
        icon={<Play className="w-4 h-4 text-green-400" />}
        title={runWith.name}
        status={<StatusBadge status={runWith.status} />}
        metaItems={[
          {
            icon: <Clock className="w-3 h-3" />,
            label: "Duration: ",
            value: formatDuration(runWith.duration),
          },
          { icon: <span>🆔</span>, label: "", value: runWith.spanId },
          { label: "TYPE: ", value: "RUN_WITH" },
        ]}
      />

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
        <TabsList className="w-full justify-start rounded-none border-b border-border bg-muted/30">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="budget">Budget</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex-1 min-h-0 mt-0">
          <Inspector.Content>
            <RunWithConfigurationSection start={start} />

            <RunWithAttributesSection attributes={attributes} />

            {start.restoration && (
              <RunWithRestorationSection
                restoration={start.restoration}
                attributes={restorationAttributes}
              />
            )}

            {metrics && <RunWithGlobalMetricsSection metrics={metrics} />}

            {start.props !== undefined && (
              <Inspector.Section
                title="INPUT PROPS"
                description="Props passed to runWith()"
                contentClassName="p-0"
              >
                <AutoHeightEditorSection title="" value={JSON.stringify(start.props, null, 2)} />
              </Inspector.Section>
            )}

            {end?.result !== undefined && (
              <Inspector.Section
                title="RESULT"
                description="Final result from runWith execution"
                contentClassName="p-0"
              >
                <AutoHeightEditorSection title="" value={JSON.stringify(end.result, null, 2)} />
              </Inspector.Section>
            )}

            {metadata && Object.keys(metadata).length > 0 && (
              <Inspector.Section title="METADATA" contentClassName="p-0">
                <AutoHeightEditorSection title="" value={JSON.stringify(metadata, null, 2)} />
              </Inspector.Section>
            )}

            {end?.error && (
              <Inspector.Section title="ERROR DETAILS" variant="error">
                <ErrorCard error={end.error as ErrorInfo} />
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
