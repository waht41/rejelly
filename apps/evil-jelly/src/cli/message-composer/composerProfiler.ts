import { performance } from "node:perf_hooks";
import { composerProfileEnabled } from "../../shared/profile/selection";

const SAMPLE_LIMIT = 2_048;
export const COMPOSER_PROFILE_WINDOW_MS = 3_000;

interface InputSample {
  readonly atMs: number;
}

interface CommitSample {
  readonly atMs: number;
  readonly batchSize: number;
  readonly latenciesMs: readonly number[];
}

export interface MetricDistribution {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface ComposerProfileSnapshot {
  readonly windowMs: number;
  readonly inputCount: number;
  readonly commitCount: number;
  readonly pendingCount: number;
  readonly textLength: number;
  readonly rowCount: number;
  readonly inputGapMs?: MetricDistribution;
  readonly commitGapMs?: MetricDistribution;
  readonly inputToCommitMs?: MetricDistribution;
  readonly batchSize?: Pick<MetricDistribution, "p95" | "max">;
  readonly stallCount: number;
}

export interface ComposerProfiler {
  recordLeftInput(cursor: number): void;
  recordCommit(cursor: number, textLength: number, rowCount: number): void;
  snapshot(windowMs?: number): ComposerProfileSnapshot;
  reset(): void;
}

function trimToLimit<T>(samples: T[]): void {
  if (samples.length > SAMPLE_LIMIT) {
    samples.splice(0, samples.length - SAMPLE_LIMIT);
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function distribution(values: readonly number[]): MetricDistribution | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
  };
}

function intervals(samples: readonly { atMs: number }[]): number[] {
  const values: number[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous && current) values.push(current.atMs - previous.atMs);
  }
  return values;
}

export function createComposerProfiler(
  now: () => number = () => performance.now(),
): ComposerProfiler {
  let inputs: InputSample[] = [];
  let pendingInputs: InputSample[] = [];
  let commits: CommitSample[] = [];
  let textLength = 0;
  let rowCount = 0;

  return {
    recordLeftInput: (cursor) => {
      if (cursor <= 0) return;
      const sample = { atMs: now() };
      inputs.push(sample);
      pendingInputs.push(sample);
      trimToLimit(inputs);
      trimToLimit(pendingInputs);
    },
    recordCommit: (_cursor, nextTextLength, nextRowCount) => {
      textLength = nextTextLength;
      rowCount = nextRowCount;
      if (pendingInputs.length === 0) return;
      const atMs = now();
      commits.push({
        atMs,
        batchSize: pendingInputs.length,
        latenciesMs: pendingInputs.map((sample) => atMs - sample.atMs),
      });
      pendingInputs = [];
      trimToLimit(commits);
    },
    snapshot: (windowMs = COMPOSER_PROFILE_WINDOW_MS) => {
      const atMs = now();
      const windowStart = atMs - windowMs;
      const visibleInputs = inputs.filter((sample) => sample.atMs >= windowStart);
      const visibleCommits = commits.filter((sample) => sample.atMs >= windowStart);
      const latencies = visibleCommits.flatMap((sample) => sample.latenciesMs);
      const batchDistribution = distribution(visibleCommits.map((sample) => sample.batchSize));
      return {
        windowMs,
        inputCount: visibleInputs.length,
        commitCount: visibleCommits.length,
        pendingCount: pendingInputs.length,
        textLength,
        rowCount,
        inputGapMs: distribution(intervals(visibleInputs)),
        commitGapMs: distribution(intervals(visibleCommits)),
        inputToCommitMs: distribution(latencies),
        batchSize: batchDistribution
          ? { p95: batchDistribution.p95, max: batchDistribution.max }
          : undefined,
        stallCount: latencies.filter((latency) => latency > 50).length,
      };
    },
    reset: () => {
      inputs = [];
      pendingInputs = [];
      commits = [];
      textLength = 0;
      rowCount = 0;
    },
  };
}

const composerProfiler = createComposerProfiler();

export function recordComposerLeftInput(cursor: number): void {
  if (composerProfileEnabled()) composerProfiler.recordLeftInput(cursor);
}

export function recordComposerCommit(cursor: number, textLength: number, rowCount: number): void {
  if (composerProfileEnabled()) composerProfiler.recordCommit(cursor, textLength, rowCount);
}

export function getComposerProfileSnapshot(): ComposerProfileSnapshot {
  return composerProfiler.snapshot();
}

export function resetComposerProfiler(): void {
  composerProfiler.reset();
}

export function emitComposerProfileReport(
  write: (line: string) => void = (line) => process.stderr.write(line),
): ComposerProfileSnapshot | undefined {
  if (!composerProfileEnabled()) return undefined;
  const snapshot = composerProfiler.snapshot();
  write(
    `[evil-jelly:composer-profile] ${JSON.stringify({
      type: "evil_jelly_composer_profile",
      version: 1,
      ...snapshot,
    })}\n`,
  );
  return snapshot;
}
