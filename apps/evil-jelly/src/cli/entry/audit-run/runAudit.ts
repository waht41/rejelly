import type { ModelAdapter } from "@rejelly/core";
import { resolveMcpSettingsLayers } from "../../../domains/mcp/configuration/configuration";
import type { McpDesiredConfig } from "../../../domains/mcp/contracts";
import {
  MCP_AUDIT_PROVENANCE_RESOURCE_KEY,
  McpAuditProvenanceCollector,
} from "../../../domains/mcp/gateway/auditDispatch";
import { createMcpRuntimeProviders } from "../../../domains/mcp/mcpServerKit";
import { McpRuntimeManager } from "../../../domains/mcp/runtime/runtimeManager";
import { SdkMcpRuntimeConnector } from "../../../domains/mcp/runtime/sdkConnector";
import { AuditAgent } from "../../../features/audit/AuditAgent";
import type { SelectableAuditFamilyKind } from "../../../features/audit/contracts";
import { docMapPath, loadDocMap } from "../../../features/audit/detectors/docDrift";
import { getEnvironmentValue } from "../../../shared/configuration/env";
import { getSettings } from "../../../shared/configuration/settings";
import { getWorkspaceRoot } from "../../../shared/fs-policy/workspace-context";
import type { EvilJellyBindings } from "../../../shared/host/bindings";
import { setBinding } from "../../../shared/host/context";
import { readMcpTrustGrants } from "../../../shared/mcp/trustRepository";
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

interface AuditMcpRuntime {
  readonly manager: McpRuntimeManager;
  readonly providers: Record<string, unknown>;
}

function resolveAuditMcpConfig(): McpDesiredConfig {
  const resolved = resolveMcpSettingsLayers(getSettings().mcp);
  return {
    servers: resolved.servers.filter((server) => server.definition.use.audit.exposure === "always"),
  };
}

async function createAuditMcpRuntime(workspaceRoot: string): Promise<AuditMcpRuntime | undefined> {
  const auditMcp = resolveAuditMcpConfig();
  if (auditMcp.servers.length === 0) return undefined;

  const manager = new McpRuntimeManager(
    new SdkMcpRuntimeConnector({ workspaceRoot, resolveEnvironment: getEnvironmentValue }),
  );
  try {
    await manager.reconcile(auditMcp, readMcpTrustGrants(workspaceRoot));
    const required = await manager.waitForRequiredServers("audit");
    const failures = required.filter((server) => server.status !== "ready");
    if (failures.length > 0) {
      throw new Error(
        `Required Audit MCP server(s) unavailable: ${failures
          .map((server) => `${server.serverId} (${server.status})`)
          .join(", ")}`,
      );
    }
    const provenance = new McpAuditProvenanceCollector();
    return {
      manager,
      providers: {
        ...createMcpRuntimeProviders(manager),
        [MCP_AUDIT_PROVENANCE_RESOURCE_KEY]: provenance,
      },
    };
  } catch (error) {
    await manager.dispose();
    throw error;
  }
}

export async function runAudit(options: RunAuditOptions): Promise<void> {
  const { model, bindings, auditOptions } = options;
  const traceId = generateTraceId();
  const workspaceRoot = getWorkspaceRoot();
  const mcpRuntime = await createAuditMcpRuntime(workspaceRoot);
  try {
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
        ...(mcpRuntime ? { providers: mcpRuntime.providers } : {}),
        trace: {
          traceId,
          attributes: { "devtool.display_name": "evil-jelly audit" },
        },
      },
    });
  } finally {
    await mcpRuntime?.manager.dispose();
  }
}
