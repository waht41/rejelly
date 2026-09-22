import {
  ensurePendingCommand,
  removePendingSubmission,
} from "../submission-dispatch/pendingSubmissions";
import { isMcpLocalCommand } from "./mcpCommands";
import { isMemoryLocalCommand } from "./memoryCommands";
import { isSkillsLocalCommand } from "./skillsCommands";

export interface ActiveTurnCommandPorts {
  showStatus: () => void;
  handleSkills: (commandText: string) => Promise<void>;
  handleMemory: (commandText: string) => Promise<void>;
  handleMcp: (commandText: string) => Promise<void>;
  runAtSafeOutputBoundary?: (operation: () => void) => () => void;
  logFailure: (error: unknown) => void;
}

export interface ActiveTurnCommands {
  handle: (commandText: string) => boolean;
  flushDeferred: () => void;
  waitForPending: () => Promise<void>;
  dispose: () => void;
}

/** Arbitrate commands submitted while a model turn is actively producing output. */
export function createActiveTurnCommands(ports: ActiveTurnCommandPorts): ActiveTurnCommands {
  const pending = new Set<Promise<void>>();
  let statusPending = false;
  let pendingStatusId: string | undefined;
  let cancelScheduledStatus: (() => void) | undefined;
  const start = (operation: () => Promise<void>) => {
    const task = operation()
      .catch(ports.logFailure)
      .finally(() => pending.delete(task));
    pending.add(task);
  };

  return {
    handle: (commandText) => {
      const normalized = commandText.trim().toLowerCase();
      if (normalized === "/status") {
        if (statusPending) return true;

        statusPending = true;
        pendingStatusId = ensurePendingCommand("/status").id;
        const runStatus = () => {
          if (!statusPending) return;
          statusPending = false;
          cancelScheduledStatus = undefined;
          if (pendingStatusId) removePendingSubmission(pendingStatusId);
          pendingStatusId = undefined;
          ports.showStatus();
        };
        cancelScheduledStatus = ports.runAtSafeOutputBoundary?.(runStatus);
        return true;
      }
      if (isSkillsLocalCommand(commandText)) {
        start(() => ports.handleSkills(commandText));
        return true;
      }
      if (isMemoryLocalCommand(commandText)) {
        start(() => ports.handleMemory(commandText));
        return true;
      }
      if (isMcpLocalCommand(commandText)) {
        start(() => ports.handleMcp(commandText));
        return true;
      }
      return false;
    },
    flushDeferred: () => {
      if (!statusPending) return;
      cancelScheduledStatus?.();
      statusPending = false;
      if (pendingStatusId) removePendingSubmission(pendingStatusId);
      pendingStatusId = undefined;
      ports.showStatus();
    },
    waitForPending: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    dispose: () => {
      cancelScheduledStatus?.();
      cancelScheduledStatus = undefined;
      statusPending = false;
      if (pendingStatusId) removePendingSubmission(pendingStatusId);
      pendingStatusId = undefined;
    },
  };
}
