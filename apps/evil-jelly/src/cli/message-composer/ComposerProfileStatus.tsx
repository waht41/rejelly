import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import {
  COMPOSER_PROFILE_WINDOW_MS,
  type ComposerProfileSnapshot,
  getComposerProfileSnapshot,
  type MetricDistribution,
} from "./composerProfiler";

const REFRESH_MS = 500;

function rounded(value: number): string {
  return String(Math.round(value));
}

function formatDistribution(value: MetricDistribution | undefined): string {
  return value ? `${rounded(value.p50)}/${rounded(value.p95)}/${rounded(value.max)}ms` : "—/—/—ms";
}

export function formatComposerProfileStatus(
  snapshot: ComposerProfileSnapshot,
): readonly [string, string] {
  const batch = snapshot.batchSize
    ? `${rounded(snapshot.batchSize.p95)}/${rounded(snapshot.batchSize.max)}`
    : "—/—";
  return [
    `Profile[left] · ${Math.round(COMPOSER_PROFILE_WINDOW_MS / 1_000)}s · events ${snapshot.inputCount} · chars ${snapshot.textLength} · rows ${snapshot.rowCount} · input gap ${formatDistribution(snapshot.inputGapMs)}`,
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
