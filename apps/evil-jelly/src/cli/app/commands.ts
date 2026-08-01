import { createInterface } from "node:readline/promises";
import { AuditAgent } from "../../features/audit/AuditAgent";
import { createBackgroundHostBindings } from "../../services/binding/cliStubBindings";
import { setBinding } from "../../services/binding/hostBindings";
import { docMapPath, loadDocMap } from "../../services/doc-drift";
import { withAbort } from "../../services/stop/withAbort";
import {
  createOpenAIModelFromEnv,
  env,
  readEnvValues,
  resolveEnvProfilePath,
  resolveGlobalEnvPath,
  saveEnvValues,
} from "../../shared/config";
import { generateTraceId } from "../../shared/lib/traceId";
import type { ParsedAuditArgs, ParsedRunArgs } from "./args";
import { runDirectUnified } from "./host/runHost";
import { runWithReview } from "./host/runWithReview";
import { collectInitConfig } from "./initConfig";

const AuditAgentWithAbort = AuditAgent.fork({ middlewares: [withAbort()] });

export async function runInitCommand(options: {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  modelId: string | undefined;
  /** With --env, write the named profile instead of the global file. */
  envFile: string | undefined;
}): Promise<void> {
  const targetPath = options.envFile
    ? resolveEnvProfilePath(options.envFile)
    : resolveGlobalEnvPath();
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const readline = interactive
    ? createInterface({
        input: process.stdin,
        output: process.stdout,
      })
    : undefined;
  const { apiKey, baseUrl, modelId } = await collectInitConfig(
    { apiKey: options.apiKey, baseUrl: options.baseUrl, modelId: options.modelId },
    readEnvValues(targetPath),
    readline ? (question) => readline.question(question) : undefined,
  ).finally(() => readline?.close());
  if (!apiKey) {
    console.error(
      interactive
        ? "OPENAI_API_KEY cannot be empty."
        : "OPENAI_API_KEY is not configured; run `evil init` in a TTY or pass --api-key.",
    );
    process.exit(1);
  }
  const filePath = saveEnvValues(targetPath, {
    OPENAI_API_KEY: apiKey,
    ...(baseUrl ? { OPENAI_BASE_URL: baseUrl } : {}),
    ...(modelId ? { OPENAI_MODEL_ID: modelId } : {}),
  });
  console.log(`Configuration saved to ${filePath}`);
}

function docDriftMissingMapMessage(): string {
  return (
    `Doc validation needs a doc map at \`${docMapPath()}\` (workspace-relative; ` +
    `override with --doc-map). It maps each doc ` +
    `file to the code paths/artifacts to validate against - see .evil-jelly/doc-map.jsonc ` +
    `in the Rejelly repo for the format.`
  );
}

export async function runAuditCommand(args: ParsedAuditArgs): Promise<void> {
  const model = createOpenAIModelFromEnv();
  const bindings = createBackgroundHostBindings();
  const traceId = generateTraceId();
  try {
    await runWithReview({
      model,
      enableReview: args.review || env.REJELLY_ENABLE_REVIEW,
      run: async () => {
        await setBinding(bindings);
        const family = args.auditOptions.family;
        bindings.logUserMessage(`Run audit family ${family} (CLI audit --family ${family}).`);

        if (
          family === "doc-drift" &&
          (args.auditOptions.docCodePaths?.length ?? 0) === 0 &&
          (await loadDocMap()) === null
        ) {
          bindings.logAssistantMessage(docDriftMissingMapMessage());
          return;
        }

        const reply = await AuditAgentWithAbort(args.auditOptions);
        bindings.logAssistantMessage(reply);
      },
      runWithOptions: {
        trace: {
          traceId,
          attributes: { "devtool.display_name": "evil-jelly audit" },
        },
      },
    });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

export async function runHeadlessUnifiedCommand(args: ParsedRunArgs): Promise<void> {
  const seedInput = args.startup.kind === "fresh" ? args.startup.seedInput : undefined;
  if (!seedInput || seedInput.trim().length === 0) {
    console.error("--headless direct UnifiedAgent mode requires --input <text>");
    process.exit(1);
  }
  const openaiModel = createOpenAIModelFromEnv();
  await runDirectUnified(
    createBackgroundHostBindings({
      autoAcceptWrite: args.autoAccept,
    }),
    {
      model: openaiModel,
      userInput: seedInput,
      enableReview: args.review || env.REJELLY_ENABLE_REVIEW,
    },
  );
}
