import type { ModelAdapter } from "@rejelly/core";
import { AuditAgent } from "../../../features/audit/AuditAgent";
import type { SelectableAuditFamilyKind } from "../../../features/audit/contracts";
import { docMapPath, loadDocMap } from "../../../features/audit/detectors/docDrift";
import type { EvilJellyBindings } from "../../../shared/host/bindings";
import { setBinding } from "../../../shared/host/context";
import { runWithReview } from "../../runtime/runWithReview";
import { generateTraceId } from "../../runtime/traceId";
import { withAbort } from "../../runtime/withAbort";

const AuditAgentWithAbort = AuditAgent.fork({ middlewares: [withAbort()] });

function docDriftMissingMapMessage(): string {
  return (
    `Doc validation needs a doc map at \`${docMapPath()}\` (workspace-relative; ` +
    `override with --doc-map). It maps each doc ` +
    `file to the code paths/artifacts to validate against - see .evil-jelly/doc-map.jsonc ` +
    `in the Rejelly repo for the format.`
  );
}

export interface RunAuditOptions {
  model: ModelAdapter;
  bindings: EvilJellyBindings;
  enableReview: boolean;
  auditOptions: {
    family: SelectableAuditFamilyKind;
    onlyActionable?: boolean;
    docFilter?: string;
    docCodePaths?: string[];
    maxSeeds?: number;
    ledgerGcDays?: number;
    disableLedgerGc?: boolean;
  };
}

export async function runAudit(options: RunAuditOptions): Promise<void> {
  const { model, bindings, auditOptions } = options;
  const traceId = generateTraceId();
  await runWithReview({
    model,
    enableReview: options.enableReview,
    run: async () => {
      await setBinding(bindings);
      const family = auditOptions.family;
      bindings.logUserMessage(`Run audit family ${family} (CLI audit --family ${family}).`);

      if (
        family === "doc-drift" &&
        (auditOptions.docCodePaths?.length ?? 0) === 0 &&
        (await loadDocMap()) === null
      ) {
        bindings.logAssistantMessage(docDriftMissingMapMessage());
        return;
      }

      const reply = await AuditAgentWithAbort(auditOptions);
      bindings.logAssistantMessage(reply);
    },
    runWithOptions: {
      trace: {
        traceId,
        attributes: { "devtool.display_name": "evil-jelly audit" },
      },
    },
  });
}
