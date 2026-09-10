import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { RuntimePhase } from "../../../shared/host/presentationBindings";
import { useOutputStore } from "../useOutputStore";
import { statusTimerAnchor } from "./state";

const STALLED_PHASE_SECONDS = 10;
const WORKING_DETAIL: Partial<Record<RuntimePhase, string>> = {
  connecting: "connecting",
  thinking: "thinking",
  streaming: "responding",
  preparing_tool: "preparing tool call",
  compacting: "compacting context",
  tool: "running tools",
};
const NETWORK_PHASES = new Set<RuntimePhase>(["connecting", "compacting"]);
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

/** Persistent status bar: runtime activity, whole-turn duration, and stall indication. */
export function RuntimeStatusLine() {
  const phase = useOutputStore((state) => state.runtime.phase);
  const phaseSince = useOutputStore((state) => state.runtime.phaseSince);
  const turnStartedAt = useOutputStore((state) => state.runtime.turnStartedAt);
  const lastOutputSecond = useOutputStore((state) =>
    Math.floor(state.runtime.lastOutputAt / 1_000),
  );
  const detail = useOutputStore((state) => state.runtime.detail);
  const toolCallGeneration = useOutputStore((state) => state.toolCallGeneration);

  const showsTimer = phase !== "idle" && phase !== "awaiting_user";
  const now = useNowTick(showsTimer);
  const turnElapsed = elapsedSeconds(now, statusTimerAnchor(turnStartedAt, phaseSince));
  const phaseElapsed = elapsedSeconds(now, phaseSince);
  const outputIdle = elapsedSeconds(now, lastOutputSecond * 1_000);
  const stalled = NETWORK_PHASES.has(phase)
    ? phaseElapsed >= STALLED_PHASE_SECONDS
    : phase === "streaming" && outputIdle >= STALLED_PHASE_SECONDS;

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

  let detailSuffix =
    (phase === "tool" && detail.startsWith("Starting MCP ")) ||
    (phase === "connecting" && detail.startsWith("Reconnecting"))
      ? detail
      : WORKING_DETAIL[phase];
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
  const color = stalled || largeToolCall ? "yellow" : undefined;
  return (
    <Box>
      <Text color={color ?? "gray"}>● </Text>
      <Text color={color} bold={stalled}>
        Working {formatElapsedTime(turnElapsed)}
      </Text>
      {detailSuffix !== undefined ? <Text dimColor> · {detailSuffix}</Text> : null}
    </Box>
  );
}
