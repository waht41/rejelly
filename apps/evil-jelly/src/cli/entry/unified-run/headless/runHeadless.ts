import { augmentAgent, type Message, type ModelAdapter } from "@rejelly/core";
import type { ReviewOptions } from "@rejelly/core/debugger";
import { SKILL_RUNTIME_PROVIDER_KEY } from "../../../../domains/skills/agent/skillRuntime";
import { UnifiedAgent } from "../../../../features/unified/UnifiedAgent";
import type { EvilJellyBindings } from "../../../../shared/host/bindings";
import { setBinding } from "../../../../shared/host/context";
import { buildSkillAwareUserMessage } from "../../../message-composer/submission/skillAwareUserMessage";
import { runWithReview } from "../../../runtime/runWithReview";
import { generateTraceId } from "../../../runtime/traceId";
import { withAbort } from "../../../runtime/withAbort";
import {
  buildConfiguredSkillRuntimeSnapshot,
  formatSkillRuntimeStartupSummary,
} from "../skillRuntime";

export interface RunHeadlessOptions {
  model: ModelAdapter;
  userInput: string;
  history?: Message[];
  /** Enable Review exporter with default endpoint or custom options. */
  enableReview?: boolean | ReviewOptions;
}

/** Runs UnifiedAgent once in headless mode (no router / no Ink prompt loop). */
export async function runHeadless(
  bindings: EvilJellyBindings,
  options: RunHeadlessOptions,
): Promise<void> {
  const { model, userInput, history } = options;
  const traceId = generateTraceId();
  try {
    const skillRuntime = await buildConfiguredSkillRuntimeSnapshot();
    const skillSummary = formatSkillRuntimeStartupSummary(skillRuntime);
    if (skillSummary) {
      bindings.logSystemEvent(`${skillSummary}\n`);
    }
    const UnifiedAgentWithAbort = augmentAgent(UnifiedAgent, [withAbort()]);
    await runWithReview({
      model,
      enableReview: options.enableReview,
      run: async () => {
        await setBinding(bindings);
        const message = await buildSkillAwareUserMessage(
          { text: userInput },
          skillRuntime.snapshot,
        );
        bindings.logUserMessage(userInput);
        const result = await UnifiedAgentWithAbort({ message, history });
        bindings.logAssistantMessage(result.reply);
      },
      runWithOptions: {
        providers: { [SKILL_RUNTIME_PROVIDER_KEY]: skillRuntime.snapshot },
        trace: {
          traceId,
          attributes: {
            "devtool.display_name": "evil-jelly unified (headless)",
            "evil_jelly.headless": true,
            "evil_jelly.skills.count": skillRuntime.snapshot.catalog.size,
            "evil_jelly.skills.catalog_fingerprint": skillRuntime.snapshot.catalog.fingerprint,
          },
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bindings.logSystemEvent(`\nRun failed: ${message}\n`);
  }
}
