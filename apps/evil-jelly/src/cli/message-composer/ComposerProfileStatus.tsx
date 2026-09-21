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
): readonly [string, string, string] {
  if (snapshot.state === "waiting") {
    return [
      `Profile[left] · waiting for input · chars ${snapshot.textLength} · rows ${snapshot.rowCount}`,
      "input: repeat —ms · steady —/—/—ms · input→commit —/—/—ms · loop lag —/—/—ms",
      "frame: commit→frame —/—/—ms · steady gap —/—/—ms · batch p95/max —/— · render —/—/—ms",
    ];
  }

  const phase =
    snapshot.state === "live"
      ? `live burst ${seconds(snapshot.durationMs)}`
      : `last burst ${seconds(snapshot.durationMs)} · ended ${snapshot.idleCapped ? ">10s" : seconds(snapshot.idleMs)} ago`;
  const frameBatch = snapshot.frameBatchSize
    ? `${rounded(snapshot.frameBatchSize.p95)}/${rounded(snapshot.frameBatchSize.max)}`
    : "—/—";
  return [
    `Profile[left] · ${phase} · events ${snapshot.inputCount} · chars ${snapshot.textLength} · rows ${snapshot.rowCount}`,
    `input: repeat ${formatDuration(snapshot.repeatDelayMs)} · steady ${formatDistribution(snapshot.steadyInputGapMs)} · input→commit ${formatDistribution(snapshot.inputToCommitMs)} · loop lag ${formatDistribution(snapshot.eventLoopDelayMs)}`,
    `frame: commit→frame ${formatDistribution(snapshot.commitToFrameMs)} · steady gap ${formatDistribution(snapshot.steadyFrameGapMs)} · batch p95/max ${frameBatch} · render ${formatDistribution(snapshot.inkRenderTimeMs)} · pending ${snapshot.pendingCount}`,
  ];
}

export function ComposerProfileStatus() {
  const [snapshot, setSnapshot] = useState(() => getComposerProfileSnapshot());

  useEffect(() => {
    const timer = setInterval(() => setSnapshot(getComposerProfileSnapshot()), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const [firstLine, secondLine, thirdLine] = formatComposerProfileStatus(snapshot);
  return (
    <Box height={3} paddingX={1} flexDirection="column">
      <Text dimColor wrap="truncate-end">
        {firstLine}
      </Text>
      <Text dimColor wrap="truncate-end">
        {secondLine}
      </Text>
      <Text dimColor wrap="truncate-end">
        {thirdLine}
      </Text>
    </Box>
  );
}
