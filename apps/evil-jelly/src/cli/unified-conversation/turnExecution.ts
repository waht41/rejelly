import { randomBytes } from "node:crypto";
import { isAbortError, type Message } from "@rejelly/core";
import { createAuthorizedMcpBindingFactory } from "../../domains/mcp/management/chatAuthorization";
import type { McpSessionControl } from "../../domains/mcp/management/sessionControl";
import { memoryIdSchema } from "../../domains/memory/model/memorySchema";
import type { SessionMemoryRuntime } from "../../domains/memory/runtime/sessionMemoryRuntime";
import type { SessionRecorder } from "../../domains/session/recorder/sessionRecorder";
import {
  commitResolvedUserInput,
  materializeFrozenUserInputMessage,
} from "../../domains/session/repository/userInputRepository";
import type { SkillRuntimeSnapshot } from "../../domains/skills/agent/skillRuntime";
import type { ConversationAgentProps } from "../../features/unified/conversationRun";
import { UnifiedAgent } from "../../features/unified/UnifiedAgent";
import type { EvilJellyBindings } from "../../shared/host/bindings";
import { releasePromptResources } from "../../shared/host/promptResourceLifecycle";
import {
  type FrozenUserInputV1,
  frozenUserInputMcpServerIds,
  projectFrozenUserInputDisplay,
  type ResolvedUserInputV1,
} from "../../shared/model/prompt/frozenUserInput";
import type { PromptInput } from "../../shared/model/prompt/promptInput";
import { formatUserInputDisplay } from "../conversation-display/history/userInputDisplay";
import { materializeSkillAwareUserInput } from "../message-composer/message-materialization/skillAwareUserMessage";
import { memoryReferenceName } from "../message-composer/suggestions/semantic-reference/referenceNaming";
import { drainSteers } from "../submission-dispatch/steerQueue";
import type { ConversationSession } from "./conversationSession";

export type ResolveMcpUserInput = (serverId: string) => {
  status: "selected" | "unavailable" | "disabled" | "untrusted";
  configFingerprint?: string;
};

export interface ConversationTurnRuntime {
  host: EvilJellyBindings;
  session: ConversationSession;
  sessionRecorder?: SessionRecorder;
  sessionId?: string;
  sessionBlobRoot?: string;
  skillSnapshot?: SkillRuntimeSnapshot;
  memoryRuntime?: SessionMemoryRuntime;
  resolveMcpUserInput?: ResolveMcpUserInput;
  mcpBindingFactory?: ConversationAgentProps["mcpBindingFactory"];
  mcpSessionControl?: McpSessionControl;
  runInterruptibleOperation: <T>(
    name: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
}

function createTurnId(): string {
  return randomBytes(12).toString("base64url");
}

function formatPersistenceError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function materializePromptInput(
  runtime: ConversationTurnRuntime,
  input: PromptInput,
): Promise<ResolvedUserInputV1> {
  return materializeSkillAwareUserInput(input, runtime.skillSnapshot, {
    mcpResolution: (serverId) => ({
      ...(runtime.resolveMcpUserInput?.(serverId) ?? { status: "unavailable" as const }),
      referenceName: serverId,
    }),
    memoryResolution: async (memoryId) => {
      if (!runtime.memoryRuntime || !memoryIdSchema.safeParse(memoryId).success) {
        return { status: "unavailable" };
      }
      try {
        const result = await runtime.memoryRuntime.service.list({
          scope: "all",
          ids: [memoryId],
          view: "detail",
        });
        const entry = result.entries[0];
        return entry
          ? {
              status: "resolved",
              scope: entry.scope,
              revision: entry.revision,
              title: entry.title,
              summary: entry.summary,
              detail: entry.detail,
              referenceName: memoryReferenceName(
                { memoryId: entry.id },
                runtime.memoryRuntime.epoch.entries,
              ),
            }
          : { status: "unavailable" };
      } catch {
        return { status: "unavailable" };
      }
    },
  });
}

async function commitUserInput(
  runtime: ConversationTurnRuntime,
  turnId: string,
  inputKind: "initial" | "steer",
  resolved: ResolvedUserInputV1,
): Promise<{ readonly frozen: FrozenUserInputV1; readonly message: Message }> {
  const frozen = runtime.sessionRecorder
    ? await runtime.sessionRecorder.recordUserInput(turnId, inputKind, resolved)
    : await commitResolvedUserInput(resolved, {
        blobRoot: runtime.sessionBlobRoot,
        imageOrdinalStart: runtime.session.nextImageOrdinal(),
      });
  const nextImageOrdinal = runtime.sessionRecorder
    ? runtime.sessionRecorder.nextImageOrdinal
    : runtime.session.nextImageOrdinal() +
      (frozen.kind === "resolved"
        ? frozen.nodes.filter((node) => node.kind === "image").length
        : 0);
  runtime.session.setNextImageOrdinal(nextImageOrdinal);
  runtime.host.logUserMessage(formatUserInputDisplay(projectFrozenUserInputDisplay(frozen)));
  return {
    frozen,
    message: await materializeFrozenUserInputMessage(frozen, {
      blobRoot: runtime.sessionBlobRoot,
    }),
  };
}

async function drainAndPrepareSteerMessages(
  runtime: ConversationTurnRuntime,
  turnId: string,
  turnMcpSelection: Set<string>,
): Promise<Message[]> {
  const messages: Message[] = [];
  const inputs = drainSteers();
  try {
    for (const input of inputs) {
      const resolved = await materializePromptInput(runtime, input).finally(() =>
        releasePromptResources(input).catch((error) =>
          runtime.host.logSystemEvent(
            `Prompt resource cleanup failed: ${formatPersistenceError(error)}\n`,
          ),
        ),
      );
      const committed = await commitUserInput(runtime, turnId, "steer", resolved);
      for (const serverId of frozenUserInputMcpServerIds(committed.frozen)) {
        turnMcpSelection.add(serverId);
      }
      messages.push(committed.message);
    }
  } catch (error) {
    await Promise.all(inputs.map((input) => releasePromptResources(input).catch(() => undefined)));
    throw error;
  }
  return messages;
}

async function closeTurnAfterFailure(
  runtime: ConversationTurnRuntime,
  turnId: string,
  status: "interrupted" | "error",
): Promise<void> {
  await runtime.sessionRecorder
    ?.completeTurn(turnId, status, runtime.session.currentBudget())
    .catch((error) =>
      runtime.host.logSystemEvent(
        `\nSession turn close failed: ${formatPersistenceError(error)}\n`,
      ),
    );
}

/** Execute one submitted prompt from durable input commit through turn closure. */
export async function executeConversationTurn(
  runtime: ConversationTurnRuntime,
  promptInput: PromptInput,
  fallbackUserText: string,
): Promise<void> {
  let submittedUserMessage: Message | undefined;
  let activeTurnId: string | undefined;
  // Set before awaiting completeTurn: a partial append must not be retried as a second closure.
  let turnClosureAttempted = false;

  try {
    const resolved = await materializePromptInput(runtime, promptInput).finally(() =>
      releasePromptResources(promptInput).catch((error) =>
        runtime.host.logSystemEvent(
          `Prompt resource cleanup failed: ${formatPersistenceError(error)}\n`,
        ),
      ),
    );
    activeTurnId = createTurnId();
    runtime.host.onTurnStart?.();
    const committed = await commitUserInput(runtime, activeTurnId, "initial", resolved);
    submittedUserMessage = committed.message;
    const turnMcpSelection = new Set(frozenUserInputMcpServerIds(committed.frozen));
    const selectedServerIds = () =>
      [...new Set([...runtime.session.mcpState().selectedServerIds, ...turnMcpSelection])].sort();
    const mcpBindingFactory = runtime.mcpBindingFactory
      ? createAuthorizedMcpBindingFactory({
          bindingFactory: runtime.mcpBindingFactory,
          control: runtime.mcpSessionControl,
          confirmTool: runtime.host.confirmTool,
          state: {
            get: runtime.session.mcpState,
            commitSelection: async (next) => {
              await runtime.sessionRecorder?.recordMcpSelection(next.selectedServerIds, "tool");
              runtime.session.setMcpState(next);
            },
            commitToolGrants: async (next) => {
              await runtime.sessionRecorder?.recordMcpToolGrants(next.toolGrants, "tool");
              runtime.session.setMcpState(next);
            },
          },
          effectiveSelectedServerIds: selectedServerIds,
        })
      : undefined;

    const result = await runtime.runInterruptibleOperation("conversation_turn", (operationSignal) =>
      UnifiedAgent({
        message: submittedUserMessage!,
        history: runtime.session.history,
        pendingUserMessages: () =>
          drainAndPrepareSteerMessages(runtime, activeTurnId!, turnMcpSelection),
        sessionBlobRoot: runtime.sessionBlobRoot,
        sessionRecorder: runtime.sessionRecorder,
        sessionId: runtime.sessionId,
        turnId: activeTurnId,
        mcpBindingFactory,
        initialTokenAnchor: runtime.session.contextTokenAnchor(),
        operationSignal,
      }),
    );

    if (result.compactHistory) {
      runtime.session.replaceHistory(result.compactHistory);
      runtime.session.clearContextTokenAnchor();
    } else {
      runtime.session.appendTurn(submittedUserMessage, result.reply, result.delta);
    }

    if (runtime.sessionRecorder) {
      if (!result.interrupted && (!result.delta || result.delta.length === 0) && result.reply) {
        await runtime.sessionRecorder.recordMessage(
          activeTurnId,
          { kind: "agent_runtime" },
          { role: "assistant", content: result.reply },
        );
      }
      turnClosureAttempted = true;
      await runtime.sessionRecorder.completeTurn(
        activeTurnId,
        result.interrupted ? "interrupted" : "completed",
        runtime.session.currentBudget(),
      );
    }
    runtime.host.logAssistantMessage(result.reply);
  } catch (error) {
    if (isAbortError(error)) {
      const abortedReply = "Task has been interrupted by user.";
      if (runtime.sessionRecorder && activeTurnId) {
        if (!turnClosureAttempted) {
          await closeTurnAfterFailure(runtime, activeTurnId, "interrupted");
        }
      } else {
        runtime.session.appendTurn(
          submittedUserMessage ?? { role: "user", content: fallbackUserText },
          abortedReply,
        );
      }
      runtime.host.logAssistantMessage(abortedReply);
      runtime.host.logSystemEvent("\n[System] Current task aborted. Returning to router.\n");
      return;
    }

    if (runtime.sessionRecorder && activeTurnId && !turnClosureAttempted) {
      await closeTurnAfterFailure(runtime, activeTurnId, "error");
    }
    throw error;
  }
}
