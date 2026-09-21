import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import {
  type ComposerProfileSnapshot,
  getComposerProfileSnapshot,
  type MetricDistribution,
} from "./composerProfiler";

const REFRESH_MS = 500;

function rounded(value: number): string {
  return String(Math.round(value));
}

function seconds(valueMs: number): string {
  return `${(valueMs / 1_000).toFixed(1)}s`;
}

function formatDistribution(value: MetricDistribution | undefined): string {
  return value ? `${rounded(value.p50)}/${rounded(value.p95)}/${rounded(value.max)}ms` : "—/—/—ms";
}

export function formatComposerProfileStatus(
  snapshot: ComposerProfileSnapshot,
): readonly [string, string] {
  if (snapshot.state === "waiting") {
    return [
      `Profile[left] · waiting for input · chars ${snapshot.textLength} · rows ${snapshot.rowCount}`,
      "input gap —/—/—ms · input→commit —/—/—ms · batch p95/max —/— · pending 0",
    ];
  }

  const batch = snapshot.batchSize
    ? `${rounded(snapshot.batchSize.p95)}/${rounded(snapshot.batchSize.max)}`
    : "—/—";
  const phase =
    snapshot.state === "live"
      ? `live burst ${seconds(snapshot.durationMs)}`
      : `last burst ${seconds(snapshot.durationMs)} · ended ${seconds(snapshot.idleMs)} ago`;
  return [
    `Profile[left] · ${phase} · events ${snapshot.inputCount} · chars ${snapshot.textLength} · rows ${snapshot.rowCount} · input gap ${formatDistribution(snapshot.inputGapMs)}`,
    `input→commit ${formatDistribution(snapshot.inputToCommitMs)} · commit gap ${formatDistribution(snapshot.commitGapMs)} · batch p95/max ${batch} · pending ${snapshot.pendingCount} · stalls ${snapshot.stallCount}`,
  ];
}

export function ComposerProfileStatus() {
  const [snapshot, setSnapshot] = useState(() => getComposerProfileSnapshot());

  useEffect(() => {
    const timer = setInterval(() => setSnapshot(getComposerProfileSnapshot()), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const [firstLine, secondLine] = formatComposerProfileStatus(snapshot);
  return (
    <Box height={2} paddingX={1} flexDirection="column">
      <Text dimColor wrap="truncate-end">
        {firstLine}
      </Text>
      <Text dimColor wrap="truncate-end">
        {secondLine}
      </Text>
    </Box>
  );
}
