import { readSessionEvents } from "../../../domains/session/journal/sessionJsonlReader";
import {
  findInspectSessionAcrossWorkspaces,
  locateInspectSession,
} from "../../../domains/session/repository/sessionLocator";
import { listSessions } from "../../../domains/session/repository/sessionStore";
import {
  type ModelCallView,
  projectModelCallInspection,
  projectModelCallList,
} from "../../../features/inspect/modelCallInspection";
import { renderInitialContextInspection } from "../../../features/inspect/renderCheckpointInspection";
import {
  renderModelCallInspection,
  renderModelCallList,
} from "../../../features/inspect/renderModelCallInspection";
import { renderSegmentInspection } from "../../../features/inspect/renderSegmentInspection";
import { renderSessionInspection } from "../../../features/inspect/renderSessionInspection";
import { renderToolCallInspection } from "../../../features/inspect/renderToolCallInspection";
import { renderTurnWaterfall } from "../../../features/inspect/renderTurnWaterfall";
import {
  extractSegmentPayload,
  projectSegmentDrilldown,
  type SegmentDrilldownInspection,
} from "../../../features/inspect/segmentInspection";
import {
  projectSessionInspection,
  resolveTurnId,
} from "../../../features/inspect/sessionInspection";
import {
  extractToolCallPayload,
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
  models?: string;
  modelId?: string;
  modelView: ModelCallView;
  input: boolean;
  attempts: boolean;
  payload: boolean;
  full: boolean;
  outputPath?: string;
  writeOutputFile: (filePath: string, content: string) => Promise<void>;
  top?: number;
}

async function writeInspectionOutput(
  content: string,
  options: RunInspectOptions,
  preservePayloadExactly = false,
): Promise<void> {
  const output = preservePayloadExactly ? content : `${content}\n`;
  if (options.outputPath) {
    await options.writeOutputFile(options.outputPath, output);
    return;
  }
  process.stdout.write(output);
}

async function printToolCall(
  inspection: ToolCallInspection,
  options: RunInspectOptions,
): Promise<void> {
  if (options.payload) {
    await writeInspectionOutput(extractToolCallPayload(inspection), options, true);
    return;
  }
  await writeInspectionOutput(
    options.json
      ? JSON.stringify(inspection, null, 2)
      : renderToolCallInspection(inspection, { full: options.full }),
    options,
  );
}

async function printSegment(
  inspection: SegmentDrilldownInspection,
  options: RunInspectOptions,
): Promise<void> {
  if (inspection.type === "tool_call_inspection_v1") {
    await printToolCall(inspection, options);
    return;
  }
  if (options.payload) {
    await writeInspectionOutput(extractSegmentPayload(inspection), options, true);
    return;
  }
  await writeInspectionOutput(
    options.json
      ? JSON.stringify(inspection, null, 2)
      : inspection.type === "initial_context_inspection_v1"
        ? renderInitialContextInspection(inspection)
        : renderSegmentInspection(inspection, { full: options.full }),
    options,
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
  if (options.modelId) {
    const modelCall = projectModelCallInspection(stored.meta, stored.events, options.modelId);
    await writeInspectionOutput(
      options.json
        ? JSON.stringify(modelCall, null, 2)
        : renderModelCallInspection(modelCall, {
            input: options.input,
            attempts: options.attempts,
          }),
      options,
    );
    return;
  }
  if (options.callId) {
    const turnId = findToolCallTurnId(stored.events, options.callId);
    const waterfall = projectTurnWaterfall(stored.meta, stored.events, turnId);
    await printToolCall(
      projectToolCallInspection(stored.meta, stored.events, waterfall, options.callId),
      options,
    );
    return;
  }
  if (options.turnId) {
    const turnId = resolveTurnId(inspection, options.turnId);
    if (options.models !== undefined) {
      const modelCalls = projectModelCallList(stored.meta, stored.events, { turnId });
      await writeInspectionOutput(
        options.json
          ? JSON.stringify(modelCalls, null, 2)
          : renderModelCallList(modelCalls, { view: options.modelView }),
        options,
      );
      return;
    }
    const waterfall = projectTurnWaterfall(stored.meta, stored.events, turnId);
    if (options.segment) {
      await printSegment(
        projectSegmentDrilldown(stored.meta, stored.events, waterfall, options.segment),
        options,
      );
      return;
    }
    if (options.json) {
      const largestSegments =
        options.top !== undefined ? projectTopContributors(waterfall, options.top) : undefined;
      await writeInspectionOutput(
        JSON.stringify(largestSegments ? { ...waterfall, largestSegments } : waterfall, null, 2),
        options,
      );
    } else {
      await writeInspectionOutput(renderTurnWaterfall(waterfall, { top: options.top }), options);
    }
    return;
  }
  if (options.models !== undefined) {
    const modelCalls = projectModelCallList(stored.meta, stored.events, {
      ...(options.models ? { selector: options.models } : {}),
    });
    await writeInspectionOutput(
      options.json
        ? JSON.stringify(modelCalls, null, 2)
        : renderModelCallList(modelCalls, { view: options.modelView }),
      options,
    );
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
  await writeInspectionOutput(
    options.json
      ? JSON.stringify(largestSegments ? { ...inspection, largestSegments } : inspection, null, 2)
      : renderSessionInspection(inspection, { topContributors: largestSegments }),
    options,
  );
}
