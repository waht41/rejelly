import { AuditAgent } from "../../features/audit/AuditAgent";
import { docMapPath, loadDocMap } from "../../features/audit/detectors/docDrift";
import { env } from "../../shared/configuration/env";
import { setBinding } from "../../shared/host/context";
import { createOpenAIModelFromEnv } from "../model-composition/createModelFromEnv";
import { generateTraceId } from "../runtime/traceId";
import { withAbort } from "../runtime/withAbort";
import type { ParsedAuditArgs } from "./args";
import { createBackgroundHostBindings } from "./host/cliStubBindings";
import { runWithReview } from "./host/runWithReview";

const AuditAgentWithAbort = AuditAgent.fork({ middlewares: [withAbort()] });

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
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
