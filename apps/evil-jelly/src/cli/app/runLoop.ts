import type { AgentSnapshot, Message, ModelAdapter } from "@rejelly/core";
import {
  takePendingExit,
  takePendingNewSession,
  takePendingResume,
} from "../../services/session/resumeControl";
import {
  generateSessionId,
  loadSession,
  type SessionBudget,
} from "../../services/session/sessionStore";
import { getWorkspaceFsPolicy } from "../../shared/fs-policy/workspace-fs-policy";
import type { EvilJellyHostBindings } from "../../shared/types";
import { connectMcpProviders } from "../../tools/mcpServerKit";
import { runEvilJellyHost } from "./host/runHost";
import { seedHistoryIntoView } from "./resume";

export async function runInteractiveLoop(params: {
  bindings: EvilJellyHostBindings;
  model: ModelAdapter;
  enableReview: boolean;
  snapshot: AgentSnapshot | undefined;
  sessionId?: string;
  seedHistory: Message[] | undefined;
  seedBudget: SessionBudget | undefined;
  /** Source trace id when the run replays a mock model (--mock); tags trace attributes. */
  mockSourceTraceId?: string;
  /** Keep replay sessions away from durable local session state. */
  isolateSessionState?: boolean;
}): Promise<void> {
  const { bindings, model, enableReview, mockSourceTraceId, isolateSessionState = false } = params;
  let { snapshot, sessionId, seedHistory, seedBudget } = params;

  // Connect optional MCP servers (e.g. devtool introspection) once, above the run loop, so the
  // connection is reused across resume segments. Best-effort: empty when disabled/unreachable.
  // The framework borrows these via runWith({ providers }); disposal stays here (finally).
  const { providers: mcpProviders, dispose: disposeMcp } = await connectMcpProviders();
  try {
    // Outer loop: each iteration is one runWith segment (own traceId). A mid-session /resume ends
    // the current run, queues a target via resumeControl, and we restart with the loaded history.
    while (true) {
      await runEvilJellyHost(bindings, {
        model,
        enableReview,
        snapshot,
        sessionId: isolateSessionState ? undefined : sessionId,
        seedHistory,
        seedBudget,
        mcpProviders,
        mockSourceTraceId,
        isolateSessionState,
      });
      if (takePendingExit()) {
        break;
      }
      if (takePendingNewSession()) {
        sessionId = isolateSessionState ? undefined : generateSessionId();
        seedHistory = undefined;
        seedBudget = undefined;
        // A new session is history-only; a startup --snapshot must not leak into later segments.
        snapshot = undefined;
        bindings.logSystemEvent(
          isolateSessionState
            ? "Started new isolated mock session.\n"
            : `Started new session ${sessionId}.\n`,
        );
        continue;
      }

      const pendingSessionId = takePendingResume();
      if (!pendingSessionId) {
        break;
      }
      if (isolateSessionState) {
        bindings.logSystemEvent("Resume is disabled during mock replay.\n");
        break;
      }
      const record = loadSession(getWorkspaceFsPolicy().getRoot(), pendingSessionId);
      if (!record) {
        bindings.logSystemEvent(`Resume failed: session ${pendingSessionId} not found.\n`);
        break;
      }
      const isSameSession = record.meta.id === sessionId;
      sessionId = record.meta.id;
      seedHistory = record.messages;
      seedBudget = record.meta.budget;
      // Resume is history-only; a startup --snapshot must not leak into later segments.
      snapshot = undefined;
      if (isSameSession) {
        // Resuming the session that is already live: its conversation is already on screen, so
        // replaying it would print every visible turn a second time. (The picker lists the
        // current session first — it is the most recently updated — so this is the common pick.)
        // The new segment still reloads the persisted record for message_history; only the
        // visual replay is skipped. Scrollback is never cleared on resume.
        bindings.logSystemEvent(`Resumed session ${sessionId} (already current).\n`);
      } else {
        seedHistoryIntoView(bindings, sessionId, seedHistory);
      }
    }
  } finally {
    await disposeMcp();
  }
}
