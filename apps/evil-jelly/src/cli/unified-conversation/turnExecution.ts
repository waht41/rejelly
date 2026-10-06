import { randomBytes } from "node:crypto";
import { isAbortError, isModelCallError, type Message } from "@rejelly/core";
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
import type {
  ConversationAgentProps,
  TurnProgressEvent,
} from "../../features/unified/conversationRun";
import { UnifiedAgent } from "../../features/unified/UnifiedAgent";
import type { EvilJellyBindings } from "../../shared/host/bindings";
import { releasePromptResources } from "../../shared/host/promptResourceLifecycle";
import { modelFailureYielded } from "../../shared/model/modelFailureProgress";
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
import type {
  TurnExecutionResult,
  TurnRecoveryStage,
  TurnRecoveryState,
  TurnToolActivity,
} from "./turnRecovery";

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

interface CommittedConversationTurn {
  turnId: string;
  userMessage: Message;
  mcpServerIds: readonly string[];
  retryHistory?: Message[];
}

function createTurnMcpBindingFactory(
  runtime: ConversationTurnRuntime,
  turnMcpSelection: Set<string>,
): ConversationAgentProps["mcpBindingFactory"] {
  if (!runtime.mcpBindingFactory) return undefined;
  const selectedServerIds = () =>
    [...new Set([...runtime.session.mcpState().selectedServerIds, ...turnMcpSelection])].sort();
  return createAuthorizedMcpBindingFactory({
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
  });
}

function recoveryState(
  input: CommittedConversationTurn,
  fields: Pick<TurnRecoveryState, "status" | "reason" | "strategy" | "message" | "toolActivity"> &
    Pick<Partial<TurnRecoveryState>, "retryHistory" | "mcpServerIds">,
): TurnRecoveryState {
  return {
    stage: "agent",
    turnId: input.turnId,
    userMessage: input.userMessage,
    mcpServerIds: input.mcpServerIds,
    ...fields,
  };
}

async function runCommittedConversationTurn(
  runtime: ConversationTurnRuntime,
  input: CommittedConversationTurn,
): Promise<TurnExecutionResult> {
  let turnClosureAttempted = false;
  let modelOutputReceived = false;
  let retryHistory: Message[] | undefined;
  let failureHistory: Message[] | undefined;
  let toolActivity: TurnToolActivity = "none";
  const observeProgress = (event: TurnProgressEvent): void => {
    switch (event) {
      case "model_output":
        modelOutputReceived = true;
        break;
      case "tool_requested":
        toolActivity = "requested";
        break;
      case "tool_execution_started":
        toolActivity = "running";
        break;
      case "tool_result_committed":
        toolActivity = "completed";
        break;
    }
  };
  const turnMcpSelection = new Set(input.mcpServerIds);
  try {
    const result = await runtime.runInterruptibleOperation("conversation_turn", (operationSignal) =>
      UnifiedAgent({
        message: input.userMessage,
        history: runtime.session.history,
        pendingUserMessages: () =>
          drainAndPrepareSteerMessages(runtime, input.turnId, turnMcpSelection),
        sessionBlobRoot: runtime.sessionBlobRoot,
        sessionRecorder: runtime.sessionRecorder,
        sessionId: runtime.sessionId,
        turnId: input.turnId,
        mcpBindingFactory: createTurnMcpBindingFactory(runtime, turnMcpSelection),
        initialTokenAnchor: runtime.session.contextTokenAnchor(),
        operationSignal,
        onTurnProgress: observeProgress,
        retryHistory: input.retryHistory,
        onModelRetryCheckpoint: (history) => {
          retryHistory = history;
        },
        onModelFailureHistory: (history) => {
          failureHistory = history;
        },
      }),
    );

    if (result.compactHistory) {
      runtime.session.replaceHistory(result.compactHistory);
      runtime.session.clearContextTokenAnchor();
    } else if (input.retryHistory) {
      runtime.session.replaceHistory([
        ...input.retryHistory,
        ...(result.delta?.length
          ? result.delta
          : [{ role: "assistant" as const, content: result.reply }]),
      ]);
      runtime.session.clearContextTokenAnchor();
    } else {
      runtime.session.appendTurn(input.userMessage, result.reply, result.delta);
    }

    if (runtime.sessionRecorder) {
      if (!result.interrupted && (!result.delta || result.delta.length === 0) && result.reply) {
        await runtime.sessionRecorder.recordMessage(
          input.turnId,
          { kind: "agent_runtime" },
          { role: "assistant", content: result.reply },
        );
      }
      turnClosureAttempted = true;
      await runtime.sessionRecorder.completeTurn(
        input.turnId,
        result.interrupted ? "interrupted" : "completed",
        runtime.session.currentBudget(),
      );
    }
    runtime.host.logAssistantMessage(result.reply);
    if (result.interrupted) {
      return {
        status: "interrupted",
        recovery: recoveryState(input, {
          status: "interrupted",
          reason: "user_abort",
          strategy: "resume_with_context",
          message: "Task was interrupted before completion.",
          toolActivity,
        }),
      };
    }
    return { status: "completed" };
  } catch (error) {
    if (isAbortError(error)) {
      if (runtime.sessionRecorder && !turnClosureAttempted) {
        await closeTurnAfterFailure(runtime, input.turnId, "interrupted");
      }
      runtime.host.logAssistantMessage("Task has been interrupted by user.");
      return {
        status: "interrupted",
        recovery: recoveryState(input, {
          status: "interrupted",
          reason: "user_abort",
          strategy: "resume_with_context",
          message: "Task was interrupted before completion.",
          toolActivity,
        }),
      };
    }

    if (!isModelCallError(error)) {
      if (runtime.sessionRecorder && !turnClosureAttempted) {
        await closeTurnAfterFailure(runtime, input.turnId, "error");
      }
      throw error;
    }

    switch (error.code) {
      case "connection_error":
      case "timeout":
      case "server_error":
      case "rate_limit": {
        const yielded = modelFailureYielded(error);
        if (
          yielded === false &&
          (retryHistory || (!modelOutputReceived && toolActivity === "none"))
        ) {
          return {
            status: "recoverable",
            recovery: recoveryState(input, {
              status: "failed",
              reason: "transient_model_failure",
              strategy: "retry_same_turn",
              message: error.message,
              toolActivity,
              mcpServerIds: [...turnMcpSelection],
              ...(retryHistory ? { retryHistory } : {}),
            }),
          };
        }
        if (runtime.sessionRecorder && !turnClosureAttempted) {
          await closeTurnAfterFailure(runtime, input.turnId, "error");
        }
        return {
          status: "recoverable",
          recovery: recoveryState(input, {
            status: "failed",
            reason: "transient_model_failure",
            strategy: "resume_with_context",
            message: error.message,
            toolActivity,
          }),
        };
      }
      case "context_length":
        if (runtime.sessionRecorder && !turnClosureAttempted) {
          await closeTurnAfterFailure(runtime, input.turnId, "error");
        }
        return {
          status: "blocked",
          message: error.message,
          suggestedCommand: "/compress",
        };
      case "auth_error":
        if (runtime.sessionRecorder && !turnClosureAttempted) {
          await closeTurnAfterFailure(runtime, input.turnId, "error");
        }
        return {
          status: "blocked",
          message: error.message,
          suggestedAction:
            "Fix the model credentials or endpoint configuration, then restart Evil.",
        };
      case "unknown":
        // Unclassified model errors end this turn, not the interactive session. Preserve only
        // committed context; partial streamed output is not a completed assistant message.
        if (failureHistory) {
          runtime.session.replaceHistory(failureHistory);
          runtime.session.clearContextTokenAnchor();
        }
        if (runtime.sessionRecorder && !turnClosureAttempted) {
          await closeTurnAfterFailure(runtime, input.turnId, "error");
        }
        return {
          status: "recoverable",
          recovery: recoveryState(input, {
            status: "failed",
            reason: "unknown_model_failure",
            strategy: "resume_with_context",
            message: error.message,
            toolActivity,
            mcpServerIds: [...turnMcpSelection],
          }),
        };
    }
  }
}

/** Execute one submitted prompt from durable input commit through turn closure. */
export async function executeConversationTurn(
  runtime: ConversationTurnRuntime,
  promptInput: PromptInput,
  fallbackUserText: string,
): Promise<TurnExecutionResult> {
  let recoveryStage: TurnRecoveryStage = "preparation";
  try {
    const resolved = await materializePromptInput(runtime, promptInput).finally(() =>
      releasePromptResources(promptInput).catch((error) =>
        runtime.host.logSystemEvent(
          `Prompt resource cleanup failed: ${formatPersistenceError(error)}\n`,
        ),
      ),
    );
    const turnId = createTurnId();
    runtime.host.onTurnStart?.();
    const committed = await commitUserInput(runtime, turnId, "initial", resolved);
    recoveryStage = "agent";
    return await runCommittedConversationTurn(runtime, {
      turnId,
      userMessage: committed.message,
      mcpServerIds: frozenUserInputMcpServerIds(committed.frozen),
    });
  } catch (error) {
    if (recoveryStage === "agent" || !isAbortError(error)) throw error;
    runtime.host.logAssistantMessage("Task has been interrupted by user.");
    return {
      status: "interrupted",
      recovery: {
        status: "interrupted",
        reason: "user_abort",
        strategy: "resume_with_context",
        stage: "preparation",
        message: "Task was interrupted before input commit completed.",
        toolActivity: "none",
        userMessage: { role: "user", content: fallbackUserText },
        mcpServerIds: [],
      },
    };
  }
}

/** Retry a pre-output transient model failure from its context without another user input or Turn. */
export async function retryConversationTurn(
  runtime: ConversationTurnRuntime,
  recovery: TurnRecoveryState,
): Promise<TurnExecutionResult> {
  if (recovery.strategy !== "retry_same_turn" || !recovery.turnId) {
    throw new Error("Conversation recovery is not eligible for same-Turn retry");
  }
  runtime.host.logSystemEvent("Retrying the previous model request…\n");
  return runCommittedConversationTurn(runtime, {
    turnId: recovery.turnId,
    userMessage: recovery.userMessage,
    mcpServerIds: recovery.mcpServerIds,
    retryHistory: recovery.retryHistory,
  });
}

/** Close a pending same-Turn retry when the operator chooses another action. */
export async function abandonPendingConversationTurn(
  runtime: ConversationTurnRuntime,
  recovery: TurnRecoveryState | undefined,
): Promise<void> {
  if (recovery?.strategy !== "retry_same_turn" || !recovery.turnId) return;
  if (recovery.retryHistory) {
    runtime.session.replaceHistory(recovery.retryHistory);
    runtime.session.clearContextTokenAnchor();
  }
  await closeTurnAfterFailure(runtime, recovery.turnId, "error");
}
