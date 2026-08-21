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
  compacting: "compacting context",
  tool: "running tools",
};
const NETWORK_PHASES = new Set<RuntimePhase>(["connecting", "compacting"]);
const GENERIC_STATUS_DETAILS = new Set(["Ready", "Waiting for input"]);

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

/** Persistent status bar: runtime activity, whole-turn duration, and stall indication. */
export function RuntimeStatusLine() {
  const phase = useOutputStore((state) => state.runtime.phase);
  const phaseSince = useOutputStore((state) => state.runtime.phaseSince);
  const turnStartedAt = useOutputStore((state) => state.runtime.turnStartedAt);
  const lastOutputSecond = useOutputStore((state) =>
    Math.floor(state.runtime.lastOutputAt / 1_000),
  );
  const detail = useOutputStore((state) => state.runtime.detail);

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
    const detailSuffix = detail && !GENERIC_STATUS_DETAILS.has(detail) ? ` · ${detail}` : "";
    return (
      <Box>
        <Text color="yellow">● </Text>
        <Text color="yellow">Waiting for you{detailSuffix}</Text>
      </Box>
    );
  }

  const detailSuffix =
    phase === "tool" && detail.startsWith("Starting MCP ") ? detail : WORKING_DETAIL[phase];
  const color = stalled ? "yellow" : undefined;
  return (
    <Box>
      <Text color={color ?? "gray"}>● </Text>
      <Text color={color} bold={stalled}>
        Working {turnElapsed}s
      </Text>
      {detailSuffix !== undefined ? <Text dimColor> · {detailSuffix}</Text> : null}
    </Box>
  );
}
