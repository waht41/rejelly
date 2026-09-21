import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { composerProfileEnabled } from "../../shared/profile/selection";

const SAMPLE_LIMIT = 2_048;
export const COMPOSER_PROFILE_BURST_IDLE_MS = 750;
export const COMPOSER_PROFILE_IDLE_DISPLAY_LIMIT_MS = 10_000;

interface InputSample {
  readonly atMs: number;
}

interface CommitSample {
  readonly atMs: number;
  readonly batchSize: number;
  readonly latenciesMs: readonly number[];
}

interface FrameSample {
  readonly atMs: number;
  readonly commitCount: number;
  readonly commitToFrameMs: readonly number[];
  readonly renderTimeMs: number;
}

export interface EventLoopDelayProbe {
  reset(): void;
  snapshot(): MetricDistribution | undefined;
}

interface ComposerProfileBurst {
  readonly startedAtMs: number;
  lastInputAtMs: number;
  totalInputCount: number;
  inputs: InputSample[];
  pendingInputs: InputSample[];
  commits: CommitSample[];
  pendingFrameCommits: CommitSample[];
  frames: FrameSample[];
  eventLoopDelayMs?: MetricDistribution;
  textLength: number;
  rowCount: number;
}

export interface MetricDistribution {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface ComposerProfileSnapshot {
  readonly state: "waiting" | "live" | "complete";
  readonly durationMs: number;
  readonly idleMs: number;
  readonly idleCapped: boolean;
  readonly inputCount: number;
  readonly commitCount: number;
  readonly pendingCount: number;
  readonly textLength: number;
  readonly rowCount: number;
  readonly repeatDelayMs?: number;
  readonly steadyInputGapMs?: MetricDistribution;
  readonly steadyCommitGapMs?: MetricDistribution;
  readonly inputToCommitMs?: MetricDistribution;
  readonly commitToFrameMs?: MetricDistribution;
  readonly steadyFrameGapMs?: MetricDistribution;
  readonly frameBatchSize?: Pick<MetricDistribution, "p95" | "max">;
  readonly inkRenderTimeMs?: MetricDistribution;
  readonly eventLoopDelayMs?: MetricDistribution;
  readonly batchSize?: Pick<MetricDistribution, "p95" | "max">;
  readonly stallCount: number;
}

export interface ComposerProfiler {
  recordLeftInput(cursor: number): void;
  recordCommit(cursor: number, textLength: number, rowCount: number): void;
  recordInkFrame(renderTimeMs: number): void;
  snapshot(): ComposerProfileSnapshot;
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

function createBurst(atMs: number, textLength: number, rowCount: number): ComposerProfileBurst {
  return {
    startedAtMs: atMs,
    lastInputAtMs: atMs,
    totalInputCount: 0,
    inputs: [],
    pendingInputs: [],
    commits: [],
    pendingFrameCommits: [],
    frames: [],
    textLength,
    rowCount,
  };
}

function burstSnapshot(
  burst: ComposerProfileBurst,
  state: "live" | "complete",
  atMs: number,
  liveEventLoopDelayMs?: MetricDistribution,
): ComposerProfileSnapshot {
  const latencies = burst.commits.flatMap((sample) => sample.latenciesMs);
  const commitToFrame = burst.frames.flatMap((sample) => sample.commitToFrameMs);
  const inputIntervals = intervals(burst.inputs);
  const commitIntervals = intervals(burst.commits);
  const frameIntervals = intervals(burst.frames);
  const batchDistribution = distribution(burst.commits.map((sample) => sample.batchSize));
  const frameBatchDistribution = distribution(burst.frames.map((sample) => sample.commitCount));
  return {
    state,
    durationMs: Math.max(0, burst.lastInputAtMs - burst.startedAtMs),
    idleMs: Math.max(0, atMs - burst.lastInputAtMs),
    idleCapped: false,
    inputCount: burst.totalInputCount,
    commitCount: burst.commits.length,
    pendingCount: burst.pendingInputs.length,
    textLength: burst.textLength,
    rowCount: burst.rowCount,
    repeatDelayMs: inputIntervals[0],
    steadyInputGapMs: distribution(inputIntervals.slice(1)),
    steadyCommitGapMs: distribution(commitIntervals.slice(1)),
    inputToCommitMs: distribution(latencies),
    commitToFrameMs: distribution(commitToFrame),
    steadyFrameGapMs: distribution(frameIntervals.slice(1)),
    frameBatchSize: frameBatchDistribution
      ? { p95: frameBatchDistribution.p95, max: frameBatchDistribution.max }
      : undefined,
    inkRenderTimeMs: distribution(burst.frames.map((sample) => sample.renderTimeMs)),
    eventLoopDelayMs: burst.eventLoopDelayMs ?? liveEventLoopDelayMs,
    batchSize: batchDistribution
      ? { p95: batchDistribution.p95, max: batchDistribution.max }
      : undefined,
    stallCount: latencies.filter((latency) => latency > 50).length,
  };
}

export function createComposerProfiler(
  now: () => number = () => performance.now(),
  eventLoopDelayProbe?: EventLoopDelayProbe,
): ComposerProfiler {
  let currentBurst: ComposerProfileBurst | undefined;
  let lastCompletedBurst: ComposerProfileBurst | undefined;
  let cappedCompletedSnapshot: ComposerProfileSnapshot | undefined;
  let textLength = 0;
  let rowCount = 0;

  const completeIdleBurst = (atMs: number): void => {
    if (currentBurst && atMs - currentBurst.lastInputAtMs >= COMPOSER_PROFILE_BURST_IDLE_MS) {
      currentBurst.eventLoopDelayMs = eventLoopDelayProbe?.snapshot();
      lastCompletedBurst = currentBurst;
      cappedCompletedSnapshot = undefined;
      currentBurst = undefined;
    }
  };

  return {
    recordLeftInput: (cursor) => {
      if (cursor <= 0) return;
      const atMs = now();
      completeIdleBurst(atMs);
      if (!currentBurst) {
        currentBurst = createBurst(atMs, textLength, rowCount);
        eventLoopDelayProbe?.reset();
      }
      const sample = { atMs };
      currentBurst.lastInputAtMs = atMs;
      currentBurst.totalInputCount += 1;
      currentBurst.inputs.push(sample);
      currentBurst.pendingInputs.push(sample);
      trimToLimit(currentBurst.inputs);
      trimToLimit(currentBurst.pendingInputs);
    },
    recordCommit: (_cursor, nextTextLength, nextRowCount) => {
      textLength = nextTextLength;
      rowCount = nextRowCount;
      if (!currentBurst) return;
      currentBurst.textLength = nextTextLength;
      currentBurst.rowCount = nextRowCount;
      if (currentBurst.pendingInputs.length === 0) return;
      const atMs = now();
      const commit = {
        atMs,
        batchSize: currentBurst.pendingInputs.length,
        latenciesMs: currentBurst.pendingInputs.map((sample) => atMs - sample.atMs),
      };
      currentBurst.commits.push(commit);
      currentBurst.pendingFrameCommits.push(commit);
      currentBurst.pendingInputs = [];
      trimToLimit(currentBurst.commits);
      trimToLimit(currentBurst.pendingFrameCommits);
    },
    recordInkFrame: (renderTimeMs) => {
      if (!currentBurst || currentBurst.pendingFrameCommits.length === 0) return;
      const atMs = now();
      currentBurst.frames.push({
        atMs,
        commitCount: currentBurst.pendingFrameCommits.length,
        commitToFrameMs: currentBurst.pendingFrameCommits.map((sample) => atMs - sample.atMs),
        renderTimeMs,
      });
      currentBurst.pendingFrameCommits = [];
      trimToLimit(currentBurst.frames);
    },
    snapshot: () => {
      const atMs = now();
      completeIdleBurst(atMs);
      if (currentBurst) {
        return burstSnapshot(currentBurst, "live", atMs, eventLoopDelayProbe?.snapshot());
      }
      if (lastCompletedBurst) {
        if (atMs - lastCompletedBurst.lastInputAtMs >= COMPOSER_PROFILE_IDLE_DISPLAY_LIMIT_MS) {
          cappedCompletedSnapshot ??= {
            ...burstSnapshot(
              lastCompletedBurst,
              "complete",
              lastCompletedBurst.lastInputAtMs + COMPOSER_PROFILE_IDLE_DISPLAY_LIMIT_MS,
            ),
            idleCapped: true,
          };
          return cappedCompletedSnapshot;
        }
        return burstSnapshot(lastCompletedBurst, "complete", atMs);
      }
      return {
        state: "waiting",
        durationMs: 0,
        idleMs: 0,
        idleCapped: false,
        inputCount: 0,
        commitCount: 0,
        pendingCount: 0,
        textLength,
        rowCount,
        stallCount: 0,
      };
    },
    reset: () => {
      currentBurst = undefined;
      lastCompletedBurst = undefined;
      cappedCompletedSnapshot = undefined;
      textLength = 0;
      rowCount = 0;
    },
  };
}

const eventLoopHistogram = composerProfileEnabled()
  ? monitorEventLoopDelay({ resolution: 1 })
  : undefined;
eventLoopHistogram?.enable();

const eventLoopDelayProbe: EventLoopDelayProbe | undefined = eventLoopHistogram
  ? {
      reset: () => eventLoopHistogram.reset(),
      snapshot: () => {
        if (eventLoopHistogram.max === 0) return undefined;
        const toMilliseconds = (nanoseconds: number): number => nanoseconds / 1_000_000;
        return {
          p50: toMilliseconds(eventLoopHistogram.percentile(50)),
          p95: toMilliseconds(eventLoopHistogram.percentile(95)),
          max: toMilliseconds(eventLoopHistogram.max),
        };
      },
    }
  : undefined;

const composerProfiler = createComposerProfiler(() => performance.now(), eventLoopDelayProbe);

export function recordComposerLeftInput(cursor: number): void {
  if (composerProfileEnabled()) composerProfiler.recordLeftInput(cursor);
}

export function recordComposerCommit(cursor: number, textLength: number, rowCount: number): void {
  if (composerProfileEnabled()) composerProfiler.recordCommit(cursor, textLength, rowCount);
}

export function recordComposerInkFrame(renderTimeMs: number): void {
  if (composerProfileEnabled()) composerProfiler.recordInkFrame(renderTimeMs);
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
  eventLoopHistogram?.disable();
  write(
    `[evil-jelly:composer-profile] ${JSON.stringify({
      type: "evil_jelly_composer_profile",
      version: 1,
      ...snapshot,
    })}\n`,
  );
  return snapshot;
}
