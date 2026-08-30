/**
 * Unified coding agent: answers, inspects the workspace, edits with host approval, and can run checks
 * through tools when useful.
 */

import {
  augmentTool,
  createAgent,
  equipInstruction,
  equipMemory,
  equipSystem,
  equipTool,
  expectResource,
  isAbortError,
  isToolLoopExceededError,
  type ToolDefinition,
} from "@rejelly/core";
import { equipMcpCatalog } from "../../domains/mcp/agent/equipMcpCatalog";
import {
  MCP_CALL_TOOL_NAME,
  MCP_REFERENCE_TOOL_NAME,
  MCP_REQUEST_TOOL_NAME,
} from "../../domains/mcp/contracts";
import {
  createMcpGatewayToolsForDispatch,
  createUnavailableMcpDispatch,
  type McpDispatchBindingFactory,
} from "../../domains/mcp/gateway/dispatch";
import { equipMemoryKit } from "../../domains/memory/agent/memoryTools";
import {
  MEMORY_RUNTIME_PROVIDER_KEY,
  type SessionMemoryRuntime,
} from "../../domains/memory/runtime/sessionMemoryRuntime";
import { promptChatResilient } from "../../domains/policy/promptChatResilient";
import { promptCompactHistory } from "../../domains/policy/promptCompactHistory";
import { materializeMessageHistory } from "../../domains/session/repository/sessionMessageMaterializer";
import { equipSkillKit } from "../../domains/skills/agent/equipSkillKit";
import { equipWebResearchKit } from "../../domains/web/kit";
import { equipReadOnlyWorkspaceKit, equipRunCommandKit } from "../../domains/workspace/kit";
import { buildWorkspaceRuleInstructionBlock } from "../../domains/workspace/workspaceRule";
import {
  createCreateFileTool,
  createDeleteFileTool,
  createEditFileTool,
} from "../../domains/workspace/write/WriteTools";
import { getBinding } from "../../shared/host/context";
import { recordAppliedToolDiff } from "../../shared/tool-observation/invocationContext";
import { evilJellyToolLoggerMiddleware } from "../../shared/tool-observation/middleware";
import { equipToolObservationRecorder } from "../../shared/tool-observation/persistence";
import { buildAutoCompactionConfig } from "./contextControl";
import type { ConversationAgentProps, ConversationAgentResult } from "./conversationRun";
import { shouldUseTerminalUserReplyRule } from "./outputSurface";
import { useStandardStreaming } from "./standardStreaming";
import { UNIFIED_TOOL_ARTIFACTS_KEY } from "./unifiedMemoryKeys";
import {
  buildUnifiedInstruction,
  buildUnifiedSystemPrompt,
  formatArtifactSummaryForInstruction,
} from "./unifiedPrompts";
import { useArtifact } from "./useArtifact";

/**
 * Runaway-safety backstop, not a working budget: the interactive loop is context-bound
 * (auto-compaction via buildAutoCompactionConfig governs occupancy) and user-attended
 * (abort/steer). Hitting this cap means a model stuck ping-ponging tools, not a long task
 * running out of allowance.
 */
const UNIFIED_MAX_TURN_STEPS = 500;

async function useUnifiedTools(props: ConversationAgentProps): Promise<void> {
  const { confirmTool, requestMemoryConfirmation } = getBinding();
  const memoryRuntime = expectResource<SessionMemoryRuntime>(MEMORY_RUNTIME_PROVIDER_KEY, {
    optional: true,
  });
  const writeObservation = { recordAppliedDiff: recordAppliedToolDiff };
  const editTool = augmentTool(createEditFileTool(confirmTool, writeObservation), [
    evilJellyToolLoggerMiddleware,
  ]);
  const createTool = augmentTool(createCreateFileTool(confirmTool, writeObservation), [
    evilJellyToolLoggerMiddleware,
  ]);
  const deleteTool = augmentTool(createDeleteFileTool(confirmTool, writeObservation), [
    evilJellyToolLoggerMiddleware,
  ]);

  await equipReadOnlyWorkspaceKit();
  equipRunCommandKit();
  // Ad-hoc web lookups (web_search + read_webpage) during normal coding/chat. INV-0009 §2: the kit
  // may be equipped on UnifiedAgent; the standalone research agent stays the fan-out-ready unit.
  equipWebResearchKit();
  useArtifact();
  if (memoryRuntime) {
    equipMemoryKit({
      service: memoryRuntime.service,
      runtime: memoryRuntime,
      source: {
        source: "agent_tool",
        ...(props.sessionId ? { sessionId: props.sessionId } : {}),
        ...(props.turnId ? { turnId: props.turnId } : {}),
      },
      requestConfirmation: requestMemoryConfirmation,
    });
  }

  equipTool(editTool);
  equipTool(createTool);
  equipTool(deleteTool);
}

async function toolsForMcpDispatch(
  baseTools: readonly ToolDefinition[],
  factory: McpDispatchBindingFactory | undefined,
): Promise<readonly ToolDefinition[]> {
  const dispatch = factory ? await factory() : createUnavailableMcpDispatch();
  const withoutGateways = baseTools.filter(
    (tool) =>
      tool.name !== MCP_REFERENCE_TOOL_NAME &&
      tool.name !== MCP_REQUEST_TOOL_NAME &&
      tool.name !== MCP_CALL_TOOL_NAME,
  );
  const gatewayTools = createMcpGatewayToolsForDispatch(dispatch).map((tool) =>
    augmentTool(tool as unknown as ToolDefinition, [evilJellyToolLoggerMiddleware]),
  );
  return [...withoutGateways, ...gatewayTools] as unknown as ToolDefinition[];
}

async function useUnifiedPrompts(props: ConversationAgentProps): Promise<void> {
  const memoryRuntime = expectResource<SessionMemoryRuntime>(MEMORY_RUNTIME_PROVIDER_KEY, {
    optional: true,
  });
  const [artifacts] = equipMemory<Record<string, string>>(UNIFIED_TOOL_ARTIFACTS_KEY, {});
  const artifactSummary = formatArtifactSummaryForInstruction(artifacts);
  const workspaceRuleBlock = await buildWorkspaceRuleInstructionBlock();

  equipSystem(
    buildUnifiedSystemPrompt({
      workspaceRuleBlock,
      useTerminalUserReplyRule: shouldUseTerminalUserReplyRule(props.replySurface),
    }),
  );
  equipInstruction(buildUnifiedInstruction({ artifactSummary }));
  if (memoryRuntime?.epoch.instruction) {
    equipInstruction(memoryRuntime.epoch.instruction);
  }
}

/**
 * /compress reuses the auto-compaction summarization path (`runContextCompaction` via
 * promptCompactHistory): one no-tools side turn over the persisted history — only the trigger is
 * manual. The caller keeps the full toolkit equipped so the request shares the session's
 * [system][tools][history...] prompt-cache prefix (see summarizeCompactionInput).
 */
async function runManualCompression(
  props: ConversationAgentProps,
  memoryRuntime?: SessionMemoryRuntime,
): Promise<ConversationAgentResult> {
  try {
    // Summarize the persisted history only: the synthetic "/compress" user turn must not be
    // picked up as a kept-verbatim recent user message.
    const history = await materializeMessageHistory(
      props.history ?? [],
      props.sessionBlobRoot ? { blobRoot: props.sessionBlobRoot } : {},
    );
    const compactHistory = await promptCompactHistory({
      message: history,
      compaction: buildAutoCompactionConfig(memoryRuntime),
    });
    return compactHistory
      ? { reply: "", compactHistory }
      : { reply: "Compression failed: summarization produced no usable summary." };
  } catch (error) {
    if (isAbortError(error)) {
      return { reply: "Compression interrupted by user." };
    }
    throw error;
  }
}

export const UnifiedAgent = createAgent<ConversationAgentProps, ConversationAgentResult>({
  id: "evil_jelly_unified_agent",
  maxTurnSteps: UNIFIED_MAX_TURN_STEPS,
  handler: async (props) => {
    const memoryRuntime = expectResource<SessionMemoryRuntime>(MEMORY_RUNTIME_PROVIDER_KEY, {
      optional: true,
    });
    const recordToolObservation = props.sessionRecorder?.recordToolObservation?.bind(
      props.sessionRecorder,
    );
    const turnId = props.turnId;
    await equipToolObservationRecorder(
      recordToolObservation && turnId
        ? {
            record: (toolCallId, block) =>
              recordToolObservation(turnId, toolCallId, {
                toolName: block.toolName,
                summary: block.summary,
                args: block.args,
                detail: block.detail,
                ok: block.ok,
              }),
          }
        : undefined,
    );
    await useUnifiedTools(props);
    await useUnifiedPrompts(props);
    equipMcpCatalog();
    equipSkillKit();
    useStandardStreaming({ textMode: "plain" });

    if (props.operation === "compress") {
      return runManualCompression(props, memoryRuntime);
    }

    try {
      const messages = await materializeMessageHistory(
        [...(props.history ?? []), props.message],
        props.sessionBlobRoot ? { blobRoot: props.sessionBlobRoot } : {},
      );
      const result = await promptChatResilient({
        message: messages,
        pendingUserMessages: props.pendingUserMessages,
        toolsForDispatch: (baseTools) => toolsForMcpDispatch(baseTools, props.mcpBindingFactory),
        compaction: buildAutoCompactionConfig(memoryRuntime),
        sessionRecorder: props.sessionRecorder,
        turnId: props.turnId,
      });

      if (result.aborted) {
        return {
          reply: "Task has been interrupted by user.",
          delta: result.delta,
          ...(result.compactedHistory ? { compactHistory: result.compactedHistory } : {}),
          interrupted: true,
        };
      }

      return {
        reply: result.data,
        delta: result.delta,
        // When mid-loop auto-compaction ran, replace the persisted history with the compacted
        // conversation instead of appending the (pre-compaction) delta; see MainCliAgent.
        ...(result.compactedHistory ? { compactHistory: result.compactedHistory } : {}),
      };
    } catch (error) {
      if (isToolLoopExceededError(error)) {
        return {
          reply:
            `Stopped at the runaway-safety cap of ${UNIFIED_MAX_TURN_STEPS} model turns in a ` +
            "single run. Review the work completed so far and continue with a narrowed " +
            "follow-up request.",
        };
      }
      throw error;
    }
  },
});
