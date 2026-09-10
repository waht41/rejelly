import { readSessionEvents } from "../../../domains/session/journal/sessionJsonlReader";
import {
  findInspectSessionAcrossWorkspaces,
  locateInspectSession,
} from "../../../domains/session/repository/sessionLocator";
import { listSessions } from "../../../domains/session/repository/sessionStore";
import { renderSessionInspection } from "../../../features/inspect/renderSessionInspection";
import { renderTurnWaterfall } from "../../../features/inspect/renderTurnWaterfall";
import {
  projectSessionInspection,
  resolveTurnId,
} from "../../../features/inspect/sessionInspection";
import { projectTurnWaterfall } from "../../../features/inspect/turnWaterfall";
import { getWorkspaceRoot } from "../../../shared/fs-policy/workspace-context";

export interface RunInspectOptions {
  sessionId?: string;
  json: boolean;
  allWorkspaces: boolean;
  turnId?: string;
}

export async function runInspect(options: RunInspectOptions): Promise<void> {
  const currentWorkspaceRoot = getWorkspaceRoot();
  const sessionId = options.sessionId ?? (await listSessions(currentWorkspaceRoot))[0]?.id;
  if (!sessionId) {
    throw new Error(`No durable Sessions found for workspace: ${currentWorkspaceRoot}`);
  }

  const location = options.allWorkspaces
    ? await findInspectSessionAcrossWorkspaces(sessionId)
    : await locateInspectSession(currentWorkspaceRoot, sessionId);
  const stored = await readSessionEvents(location.workspaceRoot, location.sessionId, {
    journalVersion: location.journalVersion,
  });
  const inspection = projectSessionInspection(
    stored.meta,
    stored.events,
    stored.warnings.map(
      (warning) =>
        `Ignored ${warning.byteLength} trailing byte(s) from an incomplete Session event at offset ${warning.offset}.`,
    ),
  );
  if (options.turnId) {
    const turnId = resolveTurnId(inspection, options.turnId);
    const waterfall = projectTurnWaterfall(stored.meta, stored.events, turnId);
    console.log(options.json ? JSON.stringify(waterfall, null, 2) : renderTurnWaterfall(waterfall));
    return;
  }
  console.log(
    options.json ? JSON.stringify(inspection, null, 2) : renderSessionInspection(inspection),
  );
}
