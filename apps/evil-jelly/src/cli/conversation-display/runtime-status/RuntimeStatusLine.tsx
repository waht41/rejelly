import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { RuntimePhase } from "../../../shared/host/presentationBindings";
import { useOutputStore } from "../useOutputStore";
import { runtimeWorkElapsedMs } from "./state";

export type RuntimeHealth = "normal" | "slow" | "recovering" | "stalled";

type RuntimeHealthPolicy = {
  clock: "phase" | "output-idle";
  slowAfterSeconds: number;
  stalledAfterSeconds: number;
};

const RUNTIME_HEALTH_POLICY: Partial<Record<RuntimePhase, RuntimeHealthPolicy>> = {
  connecting: { clock: "phase", slowAfterSeconds: 15, stalledAfterSeconds: 30 },
  thinking: { clock: "phase", slowAfterSeconds: 60, stalledAfterSeconds: 180 },
  streaming: { clock: "output-idle", slowAfterSeconds: 10, stalledAfterSeconds: 30 },
  compacting: { clock: "phase", slowAfterSeconds: 45, stalledAfterSeconds: 120 },
};

export function classifyRuntimeHealth(input: {
  phase: RuntimePhase;
  phaseElapsedSeconds: number;
  outputIdleSeconds: number;
  reconnectStage?: "backoff" | "attempt";
}): RuntimeHealth {
  if (input.phase === "reconnecting" && input.reconnectStage !== "attempt") return "recovering";
  const policy =
    input.phase === "reconnecting"
      ? RUNTIME_HEALTH_POLICY.connecting
      : RUNTIME_HEALTH_POLICY[input.phase];
  if (!policy) return "normal";
  const elapsed = policy.clock === "phase" ? input.phaseElapsedSeconds : input.outputIdleSeconds;
  if (elapsed >= policy.stalledAfterSeconds) return "stalled";
  if (elapsed >= policy.slowAfterSeconds) return "slow";
  return "normal";
}

const WORKING_DETAIL: Partial<Record<RuntimePhase, string>> = {
  connecting: "connecting",
  thinking: "thinking",
  streaming: "responding",
  preparing_tool: "preparing tool call",
  compacting: "compacting context",
  tool: "running tools",
};
const GENERIC_STATUS_DETAILS = new Set(["Ready", "Waiting for input"]);
const STARTING_RUNTIME_DETAIL = "Starting runtime…";

function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function elapsedSeconds(now: number, since: number): number {
  return Math.max(0, Math.floor((now - since) / 1_000));
}

export function formatElapsedTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${remainingSeconds}s`;
}

function formatChars(chars: number): string {
  if (chars < 1_000) return String(chars);
  if (chars < 1_000_000) return `${(chars / 1_000).toFixed(chars < 10_000 ? 1 : 0)}k`;
  return `${(chars / 1_000_000).toFixed(1)}m`;
}

function retryReason(errorCode: string): string {
  switch (errorCode) {
    case "connection_error":
      return "network unavailable";
    case "timeout":
      return "request timed out";
    case "rate_limit":
      return "rate limited";
    case "server_error":
      return "server unavailable";
    default:
      return "temporary failure";
  }
}

function healthDetail(
  phase: RuntimePhase,
  health: RuntimeHealth,
  phaseElapsed: number,
  outputIdle: number,
): string | undefined {
  if (health !== "slow" && health !== "stalled") return undefined;
  switch (phase) {
    case "connecting":
      return `waiting for first response ${formatElapsedTime(phaseElapsed)}`;
    case "streaming":
      return `no output ${formatElapsedTime(outputIdle)}`;
    case "thinking":
      return `thinking ${formatElapsedTime(phaseElapsed)}`;
    case "compacting":
      return `compacting context ${formatElapsedTime(phaseElapsed)}`;
    default:
      return undefined;
  }
}

/** Persistent status bar: runtime activity, whole-turn duration, and stall indication. */
export function RuntimeStatusLine() {
  const runtime = useOutputStore((state) => state.runtime);
  const { phase, phaseSince } = runtime;
  const lastOutputSecond = useOutputStore((state) =>
    Math.floor(state.runtime.lastOutputAt / 1_000),
  );
  const detail = runtime.detail;
  const toolCallGeneration = useOutputStore((state) => state.toolCallGeneration);

  const showsTimer = phase !== "idle" && phase !== "awaiting_user";
  const now = useNowTick(showsTimer);
  const turnElapsed = Math.floor(runtimeWorkElapsedMs(runtime, now) / 1_000);
  const phaseElapsed = elapsedSeconds(now, phaseSince);
  const outputIdle = elapsedSeconds(now, lastOutputSecond * 1_000);
  const health = classifyRuntimeHealth({
    phase,
    phaseElapsedSeconds: phaseElapsed,
    outputIdleSeconds: outputIdle,
    reconnectStage: runtime.reconnect?.stage,
  });

  if (phase === "idle") {
    return (
      <Box>
        <Text color="gray">● </Text>
        <Text color="gray">Idle</Text>
      </Box>
    );
  }

  if (phase === "awaiting_user") {
    if (detail === STARTING_RUNTIME_DETAIL) {
      return (
        <Box>
          <Text color="gray">● </Text>
          <Text color="gray">{STARTING_RUNTIME_DETAIL}</Text>
        </Box>
      );
    }
    const detailSuffix = detail && !GENERIC_STATUS_DETAILS.has(detail) ? ` · ${detail}` : "";
    return (
      <Box>
        <Text color="yellow">● </Text>
        <Text color="yellow">Waiting for you{detailSuffix}</Text>
      </Box>
    );
  }

  if (phase === "reconnecting" && runtime.reconnect) {
    const reconnect = runtime.reconnect;
    const attemptLabel =
      reconnect.maxAttempts === undefined
        ? `${reconnect.attempt}`
        : `${reconnect.attempt}/${reconnect.maxAttempts}`;
    const reason = retryReason(reconnect.errorCode);
    const reconnectDetail =
      reconnect.stage === "backoff"
        ? `retry ${attemptLabel} · ${reason} · next attempt in ${formatElapsedTime(
            Math.ceil(Math.max(0, (reconnect.retryAt ?? now) - now) / 1_000),
          )}`
        : `reconnecting · attempt ${attemptLabel} · ${reason} · ${formatElapsedTime(phaseElapsed)}`;
    return (
      <Box>
        <Text color="yellow">● </Text>
        <Text color="yellow" bold={health === "stalled"}>
          Working {formatElapsedTime(turnElapsed)} (paused)
        </Text>
        <Text dimColor> · {reconnectDetail}</Text>
      </Box>
    );
  }

  let detailSuffix =
    healthDetail(phase, health, phaseElapsed, outputIdle) ??
    (phase === "tool" && detail.startsWith("Starting MCP ") ? detail : WORKING_DETAIL[phase]);
  if (phase === "preparing_tool" && toolCallGeneration) {
    const names = [...new Set(toolCallGeneration.calls.map((call) => call.name).filter(Boolean))];
    const subject =
      toolCallGeneration.calls.length === 1 && names.length === 1
        ? names[0]
        : `${toolCallGeneration.calls.length} tool calls`;
    const size =
      toolCallGeneration.totalArgumentChars >= 2_000
        ? ` · ${formatChars(toolCallGeneration.totalArgumentChars)} chars`
        : "";
    detailSuffix = `preparing ${subject}${size}`;
  }
  const largeToolCall =
    phase === "preparing_tool" && (toolCallGeneration?.totalArgumentChars ?? 0) >= 50_000;
  const color = health !== "normal" || largeToolCall ? "yellow" : undefined;
  return (
    <Box>
      <Text color={color ?? "gray"}>● </Text>
      <Text color={color} bold={health === "stalled"}>
        Working {formatElapsedTime(turnElapsed)}
      </Text>
      {detailSuffix !== undefined ? <Text dimColor> · {detailSuffix}</Text> : null}
    </Box>
  );
}
