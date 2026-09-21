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

function formatDuration(value: number | undefined): string {
  return value === undefined ? "—ms" : `${rounded(value)}ms`;
}

export function formatComposerProfileStatus(
  snapshot: ComposerProfileSnapshot,
): readonly [string, string] {
  if (snapshot.state === "waiting") {
    return [
      `Profile[left] · waiting for input · chars ${snapshot.textLength} · rows ${snapshot.rowCount}`,
      "repeat delay —ms · steady input —/—/—ms · input→commit —/—/—ms · pending 0",
    ];
  }

  const batch = snapshot.batchSize
    ? `${rounded(snapshot.batchSize.p95)}/${rounded(snapshot.batchSize.max)}`
    : "—/—";
  const phase =
    snapshot.state === "live"
      ? `live burst ${seconds(snapshot.durationMs)}`
      : `last burst ${seconds(snapshot.durationMs)} · ended ${snapshot.idleCapped ? ">10s" : seconds(snapshot.idleMs)} ago`;
  return [
    `Profile[left] · ${phase} · events ${snapshot.inputCount} · chars ${snapshot.textLength} · rows ${snapshot.rowCount} · repeat delay ${formatDuration(snapshot.repeatDelayMs)} · steady input ${formatDistribution(snapshot.steadyInputGapMs)}`,
    `input→commit ${formatDistribution(snapshot.inputToCommitMs)} · steady commit ${formatDistribution(snapshot.steadyCommitGapMs)} · batch p95/max ${batch} · pending ${snapshot.pendingCount} · stalls ${snapshot.stallCount}`,
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
