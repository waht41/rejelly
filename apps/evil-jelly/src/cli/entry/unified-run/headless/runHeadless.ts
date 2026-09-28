import { randomBytes } from "node:crypto";
import { augmentAgent, type Message, type ModelAdapter } from "@rejelly/core";
import type { ReviewOptions } from "@rejelly/core/debugger";
import {
  createSessionMemoryRuntime,
  MEMORY_RUNTIME_PROVIDER_KEY,
} from "../../../../domains/memory/runtime/sessionMemoryRuntime";
import { createPersistentMemoryService } from "../../../../domains/memory/service/persistentMemoryServiceImpl";
import { observeSessionRecorder } from "../../../../domains/session/recorder/sessionObservationRecorder";
import {
  openSessionRecorder,
  type SessionRecorder,
} from "../../../../domains/session/recorder/sessionRecorder";
import {
  generateSessionId,
  type SessionStoragePaths,
} from "../../../../domains/session/repository/sessionStore";
import {
  commitResolvedUserInput,
  materializeFrozenUserInputMessage,
} from "../../../../domains/session/repository/userInputRepository";
import { SKILL_RUNTIME_PROVIDER_KEY } from "../../../../domains/skills/agent/skillRuntime";
import { UnifiedAgent } from "../../../../features/unified/UnifiedAgent";
import { getWorkspaceRoot } from "../../../../shared/fs-policy/workspace-context";
import type { EvilJellyBindings } from "../../../../shared/host/bindings";
import { setBinding } from "../../../../shared/host/context";
import { getSessionModelConfiguration } from "../../../../shared/model/observation/modelConfiguration";
import { textPromptInput } from "../../../../shared/model/prompt/promptInput";
import { materializeSkillAwareUserInput } from "../../../message-composer/message-materialization/skillAwareUserMessage";
import { runWithReview } from "../../../runtime/runWithReview";
import { generateTraceId } from "../../../runtime/traceId";
import { withAbort } from "../../../runtime/withAbort";
import { buildConfiguredSkillRuntimeSnapshot } from "../../../skill-runtime/configuredRuntime";
import { formatSkillRuntimeStartupSummary } from "../../../skill-runtime/startupSummary";
import { type HeadlessResultError, writeHeadlessResult } from "./headlessResult";

export interface RunHeadlessOptions {
  model: ModelAdapter;
  userInput: string;
  history?: Message[];
  /** Enable Review exporter with default endpoint or custom options. */
  enableReview?: boolean | ReviewOptions;
  /** CLI version recorded in an opt-in durable headless Session. */
  appVersion?: string;
  /** When present, record this one-shot run in the selected portable Session store. */
  sessionStorage?: SessionStoragePaths;
  /** Original portable Session store root recorded in result metadata. */
  sessionStoreRoot?: string;
  /** Versioned machine-readable result path for eval harnesses. */
  resultJsonPath?: string;
  /** Composition-root filesystem writer for the result artifact. */
  writeResultFile?: (filePath: string, content: string) => Promise<void>;
}

function createTurnId(): string {
  return randomBytes(12).toString("base64url");
}

async function endSegmentBestEffort(
  recorder: SessionRecorder | undefined,
  input: Parameters<SessionRecorder["endSegment"]>[0],
  bindings: EvilJellyBindings,
): Promise<void> {
  if (!recorder || recorder.ended) return;
  try {
    await recorder.endSegment(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bindings.logSystemEvent(`\nSession close failed: ${message}\n`);
  }
}

/** Runs UnifiedAgent once in headless mode (no router / no Ink prompt loop). */
export async function runHeadless(
  bindings: EvilJellyBindings,
  options: RunHeadlessOptions,
): Promise<void> {
  const { model, userInput, history } = options;
  const startedAt = Date.now();
  const traceId = generateTraceId();
  const sessionId = options.sessionStorage ? generateSessionId() : undefined;
  let recorder: SessionRecorder | undefined;
  let activeTurnId: string | undefined;
  let turnClosed = false;
  let output = "";
  let resultStatus: "completed" | "error" = "error";
  let terminationReason: "completed" | "agent_error" | "session_error" = "agent_error";
  let resultError: HeadlessResultError | undefined;
  try {
    const skillRuntime = await buildConfiguredSkillRuntimeSnapshot();
    const skillSummary = formatSkillRuntimeStartupSummary(skillRuntime);
    const memoryRuntime = await createSessionMemoryRuntime(
      createPersistentMemoryService({ workspaceRoot: getWorkspaceRoot() }),
    );
    for (const diagnostic of memoryRuntime.diagnostics) {
      bindings.logSystemEvent(`Memory warning: ${diagnostic}\n`);
    }
    if (skillSummary) {
      bindings.logSystemEvent(`${skillSummary}\n`);
    }
    if (sessionId && options.sessionStorage) {
      if (!options.appVersion) {
        throw new Error("Headless Session recording requires an app version");
      }
      const modelConfiguration = getSessionModelConfiguration(model);
      recorder = observeSessionRecorder(
        await openSessionRecorder({
          workspaceRoot: getWorkspaceRoot(),
          sessionId,
          traceId,
          originator: "evil-jelly-cli",
          appVersion: options.appVersion,
          modelId: model.id,
          ...(model.provider ? { provider: model.provider } : {}),
          cwd: process.cwd(),
          ...options.sessionStorage,
        }),
        { modelConfiguration },
      );
      bindings.logSystemEvent(`[Headless] Session ID: ${sessionId}\n`);
    }
    const UnifiedAgentWithAbort = augmentAgent(UnifiedAgent, [withAbort()]);
    await runWithReview({
      model,
      enableReview: options.enableReview,
      run: async () => {
        await setBinding(bindings);
        const resolved = await materializeSkillAwareUserInput(
          textPromptInput(userInput),
          skillRuntime.snapshot,
        );
        activeTurnId = createTurnId();
        const frozen = recorder
          ? await recorder.recordUserInput(activeTurnId, "initial", resolved)
          : await commitResolvedUserInput(resolved);
        const message = await materializeFrozenUserInputMessage(frozen, {
          blobRoot: options.sessionStorage?.blobRoot,
        });
        bindings.logUserMessage(userInput);
        const result = await UnifiedAgentWithAbort({
          message,
          history,
          ...(recorder
            ? {
                sessionRecorder: recorder,
                sessionId,
                turnId: activeTurnId,
                sessionBlobRoot: options.sessionStorage?.blobRoot,
              }
            : {}),
        });
        if (recorder) {
          if (!result.interrupted && (!result.delta || result.delta.length === 0) && result.reply) {
            await recorder.recordMessage(
              activeTurnId,
              { kind: "agent_runtime" },
              { role: "assistant", content: result.reply },
            );
          }
          turnClosed = true;
          await recorder.completeTurn(
            activeTurnId,
            result.interrupted ? "interrupted" : "completed",
          );
        }
        output = result.reply;
        bindings.logAssistantMessage(result.reply);
      },
      runWithOptions: {
        providers: {
          [SKILL_RUNTIME_PROVIDER_KEY]: skillRuntime.snapshot,
          [MEMORY_RUNTIME_PROVIDER_KEY]: memoryRuntime,
        },
        trace: {
          traceId,
          attributes: {
            "devtool.display_name": "evil-jelly unified (headless)",
            "evil_jelly.headless": true,
            ...(sessionId ? { "session.id": sessionId } : {}),
            "evil_jelly.skills.count": skillRuntime.snapshot.catalog.size,
            "evil_jelly.skills.catalog_fingerprint": skillRuntime.snapshot.catalog.fingerprint,
          },
        },
      },
    });
    await endSegmentBestEffort(recorder, { status: "completed", reason: "exit" }, bindings);
    resultStatus = "completed";
    terminationReason = "completed";
  } catch (error) {
    if (recorder && activeTurnId && !turnClosed) {
      turnClosed = true;
      await recorder.completeTurn(activeTurnId, "error").catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : String(error);
    resultError = { phase: recorder ? "agent_run" : "startup", message };
    await endSegmentBestEffort(
      recorder,
      { status: "error", reason: "error", errorMessage: message },
      bindings,
    );
    bindings.logSystemEvent(`\nRun failed: ${message}\n`);
    process.exitCode = 1;
  } finally {
    try {
      await recorder?.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      bindings.logSystemEvent(`\nSession writer close failed: ${message}\n`);
      resultStatus = "error";
      terminationReason = "session_error";
      resultError = { phase: "session_finalize", message };
      process.exitCode = 1;
    }
  }

  if (
    options.resultJsonPath &&
    sessionId &&
    options.sessionStorage &&
    options.sessionStoreRoot &&
    options.writeResultFile
  ) {
    try {
      await writeHeadlessResult({
        resultPath: options.resultJsonPath,
        runId: sessionId,
        sessionId,
        sessionStoreRoot: options.sessionStoreRoot,
        sessionStorage: options.sessionStorage,
        workspaceRoot: getWorkspaceRoot(),
        traceId,
        model,
        reviewEnabled: Boolean(options.enableReview),
        input: userInput,
        output,
        status: resultStatus,
        terminationReason,
        exitCode: resultStatus === "completed" ? 0 : 1,
        startedAt,
        endedAt: Date.now(),
        ...(resultError ? { error: resultError } : {}),
        writeResultFile: options.writeResultFile,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      bindings.logSystemEvent(`\nResult JSON write failed: ${message}\n`);
      process.exitCode = 1;
    }
  }
}
