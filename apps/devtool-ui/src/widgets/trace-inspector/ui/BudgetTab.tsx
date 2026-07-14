import type {
  BudgetItemSummary,
  BudgetSummaryForSpan,
  BudgetUsageSummary,
} from "@entities/trace/lib/budgetSelectors.ts";
import { CircleDollarSign, Cpu, Layers, Sigma, UserRound, Wrench } from "lucide-react";
import type { ReactNode } from "react";

interface BudgetTabProps {
  summary: BudgetSummaryForSpan;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.round(value).toLocaleString();
}

function formatCostValue(unit: string, value: number): string {
  if (unit === "micro_usd") {
    return `$${(value / 1_000_000).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    })}`;
  }
  if (unit === "micro_cny") {
    return `¥${(value / 1_000_000).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    })}`;
  }
  if (unit.startsWith("micro_")) {
    return `${formatNumber(value)} ${unit}`;
  }
  return `${formatNumber(value)} ${unit}`;
}

function formatCosts(costs: Record<string, number>): string {
  const entries = Object.entries(costs).filter(([, value]) => value !== 0);
  if (entries.length === 0) return "—";
  return entries.map(([unit, value]) => formatCostValue(unit, value)).join(" / ");
}

function isEmptySummary(summary: BudgetUsageSummary): boolean {
  return (
    summary.totalTokens === 0 &&
    summary.promptTokens === 0 &&
    summary.completionTokens === 0 &&
    summary.callCount === 0 &&
    Object.keys(summary.costs).length === 0 &&
    summary.items.length === 0
  );
}

function StatCard({
  label,
  summary,
  icon,
}: {
  label: string;
  summary: BudgetUsageSummary;
  icon: ReactNode;
}) {
  return (
    <div className="rounded border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] text-muted-foreground">Tokens</div>
          <div className="mt-0.5 text-sm font-semibold text-foreground">
            {formatNumber(summary.totalTokens)}
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {formatNumber(summary.promptTokens)} in / {formatNumber(summary.completionTokens)} out
          </div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">Cost</div>
          <div className="mt-0.5 whitespace-nowrap text-sm font-semibold tabular-nums text-foreground">
            {formatCosts(summary.costs)}
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {formatNumber(summary.callCount)} calls
          </div>
        </div>
      </div>
    </div>
  );
}

function ItemIcon({ type }: { type: BudgetItemSummary["type"] }) {
  if (type === "model") {
    return <Cpu className="h-3.5 w-3.5 text-sky-400" />;
  }
  return <Wrench className="h-3.5 w-3.5 text-amber-400" />;
}

const DETAIL_LABELS: Record<string, string> = {
  reasoningTokens: "Reasoning",
  cacheReadTokens: "Cache read",
  cacheWriteTokens: "Cache write",
  cacheCreationTokens: "Cache create",
};

const DETAIL_ORDER = [
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheCreationTokens",
];

function getTokenDetailEntries(details: Record<string, number> | undefined) {
  if (!details) return [];

  const keys = [
    ...DETAIL_ORDER.filter((key) => details[key] !== undefined),
    ...Object.keys(details)
      .filter((key) => !DETAIL_ORDER.includes(key))
      .sort((a, b) => a.localeCompare(b)),
  ];

  return keys
    .map((key) => ({
      key,
      label: DETAIL_LABELS[key] ?? key,
      value: Number(details[key]) || 0,
    }))
    .filter((entry) => entry.value !== 0);
}

function TokenDetails({ details }: { details?: Record<string, number> }) {
  const entries = getTokenDetailEntries(details);
  if (entries.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap gap-1 pl-5">
      {entries.map((entry) => (
        <span
          key={entry.key}
          className="rounded border border-border/60 bg-background/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
        >
          {entry.label}:{" "}
          <span className="font-medium text-foreground/85">{formatNumber(entry.value)}</span>
        </span>
      ))}
    </div>
  );
}

function BudgetItemRow({ item }: { item: BudgetItemSummary }) {
  const subtitle =
    item.type === "model"
      ? [
          item.provider,
          `${formatNumber(item.promptTokens)} in`,
          `${formatNumber(item.completionTokens)} out`,
        ]
          .filter(Boolean)
          .join(" / ")
      : [`${formatNumber(item.quantity ?? 0)} ${item.unit ?? "unit"}`].join("");

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border/50 px-3 py-2 last:border-b-0">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <ItemIcon type={item.type} />
          <span className="truncate text-xs font-medium text-foreground">{item.name}</span>
        </div>
        <div className="mt-0.5 truncate pl-5 text-[10px] text-muted-foreground">{subtitle}</div>
        {item.type === "model" ? <TokenDetails details={item.details} /> : null}
      </div>
      <div className="text-right">
        <div className="text-xs font-semibold text-foreground">
          {formatNumber(item.totalTokens)}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {formatNumber(item.callCount)} calls
        </div>
      </div>
      <div className="min-w-24 whitespace-nowrap text-right text-xs font-semibold tabular-nums text-foreground">
        {formatCosts(item.costs)}
      </div>
    </div>
  );
}

function ItemsSection({ summary }: { summary: BudgetUsageSummary }) {
  if (summary.items.length === 0) {
    return null;
  }

  return (
    <div className="rounded border border-border/60 bg-muted/10">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 border-b border-border/60 bg-muted/30 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Item</span>
        <span className="text-right">Tokens</span>
        <span className="min-w-24 text-right">Cost</span>
      </div>
      {summary.items.map((item) => (
        <BudgetItemRow key={item.key} item={item} />
      ))}
    </div>
  );
}

export function BudgetTab({ summary }: BudgetTabProps) {
  if (isEmptySummary(summary.aggregate)) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        No budget data available
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background custom-scrollbar">
      <div className="space-y-4 p-3">
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
          <StatCard
            label="Own"
            summary={summary.own}
            icon={<UserRound className="h-3.5 w-3.5" />}
          />
          <StatCard
            label="Children"
            summary={summary.children}
            icon={<Layers className="h-3.5 w-3.5" />}
          />
          <StatCard
            label="Aggregate"
            summary={summary.aggregate}
            icon={<Sigma className="h-3.5 w-3.5" />}
          />
        </div>

        <div>
          <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <CircleDollarSign className="h-3.5 w-3.5" />
            <span>Aggregate Items</span>
          </div>
          <ItemsSection summary={summary.aggregate} />
        </div>
      </div>
    </div>
  );
}
