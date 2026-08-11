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
  isAbortError,
  isToolLoopExceededError,
} from "@rejelly/core";
import { promptChatResilient } from "../../domains/policy/promptChatResilient";
import { promptCompactHistory } from "../../domains/policy/promptCompactHistory";
import { equipSkillKit } from "../../domains/skills/agent/equipSkillKit";
import { equipWebResearchKit } from "../../domains/web/kit";
import { equipReadOnlyWorkspaceKit, equipRunCommandKit } from "../../domains/workspace/kit";
import { buildWorkspaceRuleInstructionBlock } from "../../domains/workspace/workspaceRule";
import {
  createCreateFileTool,
  createDeleteFileTool,
  createEditFileTool,
} from "../../domains/workspace/write/WriteTools";
import type { ConversationAgentProps, ConversationAgentResult } from "../../shared/AgentShared";
import { getBinding } from "../../shared/host/hostBindings";
import { shouldUseTerminalUserReplyRule } from "../../shared/host/output-surface";
import { useStandardStreaming } from "../../shared/host/standardStreaming";
import { evilJellyToolLoggerMiddleware } from "../../shared/host/withToolLogger";
import { equipMcpServerKit } from "../../tools/mcpServerKit";
import { buildAutoCompactionConfig } from "./contextControl";
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

async function useUnifiedTools(): Promise<void> {
  const { confirmTool } = getBinding();
  const editTool = augmentTool(createEditFileTool(confirmTool), [evilJellyToolLoggerMiddleware]);
  const createTool = augmentTool(createCreateFileTool(confirmTool), [
    evilJellyToolLoggerMiddleware,
  ]);
  const deleteTool = augmentTool(createDeleteFileTool(confirmTool), [
    evilJellyToolLoggerMiddleware,
  ]);

  await equipReadOnlyWorkspaceKit();
  equipRunCommandKit();
  // Ad-hoc web lookups (web_search + read_webpage) during normal coding/chat. INV-0009 §2: the kit
  // may be equipped on UnifiedAgent; the standalone research agent stays the fan-out-ready unit.
  equipWebResearchKit();
  // Opt-in (--devtool), best-effort: lets evil introspect its own run via the
  // devtool MCP. Skipped silently when disabled; warns and continues without the
  // tools when the server is down (the user explicitly asked for them).
  await equipMcpServerKit();

  useArtifact();

  equipTool(editTool);
  equipTool(createTool);
  equipTool(deleteTool);
}

async function useUnifiedPrompts(props: ConversationAgentProps): Promise<void> {
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
}

/**
 * /compress reuses the auto-compaction summarization path (`runContextCompaction` via
 * promptCompactHistory): one no-tools side turn over the persisted history — only the trigger is
 * manual. The caller keeps the full toolkit equipped so the request shares the session's
 * [system][tools][history...] prompt-cache prefix (see summarizeCompactionInput).
 */
async function runManualCompression(
  props: ConversationAgentProps,
): Promise<ConversationAgentResult> {
  try {
    // Summarize the persisted history only: the synthetic "/compress" user turn must not be
    // picked up as a kept-verbatim recent user message.
    const compactHistory = await promptCompactHistory({
      message: props.history ?? [],
      compaction: buildAutoCompactionConfig(),
      sessionBlobRoot: props.sessionBlobRoot,
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
    await useUnifiedTools();
    await useUnifiedPrompts(props);
    equipSkillKit();
    useStandardStreaming({ textMode: "plain" });

    if (props.operation === "compress") {
      return runManualCompression(props);
    }

    try {
      const result = await promptChatResilient({
        message: [...(props.history ?? []), props.message],
        pendingUserMessages: props.pendingUserMessages,
        compaction: buildAutoCompactionConfig(),
        sessionRecorder: props.sessionRecorder,
        turnId: props.turnId,
        sessionBlobRoot: props.sessionBlobRoot,
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
