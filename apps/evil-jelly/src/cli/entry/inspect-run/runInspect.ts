import { readSessionEvents } from "../../../domains/session/journal/sessionJsonlReader";
import {
  findInspectSessionAcrossWorkspaces,
  locateInspectSession,
} from "../../../domains/session/repository/sessionLocator";
import { listSessions } from "../../../domains/session/repository/sessionStore";
import { renderInitialContextInspection } from "../../../features/inspect/renderCheckpointInspection";
import { renderSegmentInspection } from "../../../features/inspect/renderSegmentInspection";
import { renderSessionInspection } from "../../../features/inspect/renderSessionInspection";
import { renderToolCallInspection } from "../../../features/inspect/renderToolCallInspection";
import { renderTurnWaterfall } from "../../../features/inspect/renderTurnWaterfall";
import {
  dumpSegmentPayload,
  projectSegmentDrilldown,
  type SegmentDrilldownInspection,
} from "../../../features/inspect/segmentInspection";
import {
  projectSessionInspection,
  resolveTurnId,
} from "../../../features/inspect/sessionInspection";
import {
  dumpToolCallPayload,
  findToolCallTurnId,
  projectToolCallInspection,
  type ToolCallInspection,
} from "../../../features/inspect/toolCallInspection";
import {
  projectSessionTopContributors,
  projectTopContributors,
  projectTurnWaterfall,
} from "../../../features/inspect/turnWaterfall";
import { getWorkspaceRoot } from "../../../shared/fs-policy/workspace-context";

export interface RunInspectOptions {
  sessionId?: string;
  json: boolean;
  allWorkspaces: boolean;
  turnId?: string;
  segment?: string;
  callId?: string;
  dump: boolean;
  full: boolean;
  top?: number;
}

function printToolCall(inspection: ToolCallInspection, options: RunInspectOptions): void {
  if (options.dump) {
    process.stdout.write(dumpToolCallPayload(inspection));
    return;
  }
  console.log(
    options.json
      ? JSON.stringify(inspection, null, 2)
      : renderToolCallInspection(inspection, { full: options.full }),
  );
}

function printSegment(inspection: SegmentDrilldownInspection, options: RunInspectOptions): void {
  if (inspection.type === "tool_call_inspection_v1") {
    printToolCall(inspection, options);
    return;
  }
  if (options.dump) {
    process.stdout.write(dumpSegmentPayload(inspection));
    return;
  }
  console.log(
    options.json
      ? JSON.stringify(inspection, null, 2)
      : inspection.type === "initial_context_inspection_v1"
        ? renderInitialContextInspection(inspection)
        : renderSegmentInspection(inspection, { full: options.full }),
  );
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
  if (options.callId) {
    const turnId = findToolCallTurnId(stored.events, options.callId);
    const waterfall = projectTurnWaterfall(stored.meta, stored.events, turnId);
    printToolCall(
      projectToolCallInspection(stored.meta, stored.events, waterfall, options.callId),
      options,
    );
    return;
  }
  if (options.turnId) {
    const turnId = resolveTurnId(inspection, options.turnId);
    const waterfall = projectTurnWaterfall(stored.meta, stored.events, turnId);
    if (options.segment) {
      printSegment(
        projectSegmentDrilldown(stored.meta, stored.events, waterfall, options.segment),
        options,
      );
      return;
    }
    if (options.json) {
      const largestSegments =
        options.top !== undefined ? projectTopContributors(waterfall, options.top) : undefined;
      console.log(
        JSON.stringify(largestSegments ? { ...waterfall, largestSegments } : waterfall, null, 2),
      );
    } else {
      console.log(renderTurnWaterfall(waterfall, { top: options.top }));
    }
    return;
  }
  const largestSegments =
    options.top !== undefined
      ? projectSessionTopContributors(
          inspection.turns.map((turn) =>
            projectTurnWaterfall(stored.meta, stored.events, turn.turnId),
          ),
          options.top,
        )
      : undefined;
  console.log(
    options.json
      ? JSON.stringify(largestSegments ? { ...inspection, largestSegments } : inspection, null, 2)
      : renderSessionInspection(inspection, { topContributors: largestSegments }),
  );
}
