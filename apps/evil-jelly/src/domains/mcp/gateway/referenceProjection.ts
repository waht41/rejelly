import {
  renderPseudoXmlElement,
  renderPseudoXmlEmptyElement,
} from "../../../shared/model/prompt/pseudoXml";
import { MCP_CONTRACT_LIMITS, type McpReferenceMatch, type McpReferenceResult } from "../contracts";

type ReferenceDetail = "full" | "summary" | "names";

export interface McpReferenceProjectionOptions {
  readonly outputBytes?: number;
  readonly singleToolOutputBytes?: number;
}

interface MatchGroup {
  readonly serverId: string;
  readonly matches: McpReferenceMatch[];
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function groupMatches(matches: readonly McpReferenceMatch[]): readonly MatchGroup[] {
  const groups = new Map<string, McpReferenceMatch[]>();
  for (const match of matches) {
    const group = groups.get(match.identity.serverId) ?? [];
    group.push(match);
    groups.set(match.identity.serverId, group);
  }
  return [...groups].map(([serverId, groupedMatches]) => ({
    serverId,
    matches: groupedMatches,
  }));
}

function serverCallability(matches: readonly McpReferenceMatch[]): "true" | "false" | "mixed" {
  const callable = matches.filter((match) => match.callable).length;
  if (callable === 0) return "false";
  return callable === matches.length ? "true" : "mixed";
}

function markdownName(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function summaryDescription(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderFullTool(match: McpReferenceMatch): string {
  const description = renderPseudoXmlElement("description", match.description);
  const schema = renderPseudoXmlElement("input_schema", JSON.stringify(match.inputSchema), {
    format: "json",
  });
  return renderPseudoXmlElement("tool", `${description}\n${schema}`, {
    name: match.identity.nativeToolName,
  });
}

function renderServer(group: MatchGroup, detail: ReferenceDetail): string {
  const first = group.matches[0]!;
  const attributes = {
    id: group.serverId,
    status: "ready",
    callable: serverCallability(group.matches),
    ...(detail === "full" ? { catalog_revision: first.catalogRevision } : {}),
  };
  if (detail === "full") {
    return renderPseudoXmlElement(
      "server",
      group.matches.map(renderFullTool).join("\n"),
      attributes,
    );
  }
  const lines = group.matches.map((match) =>
    detail === "summary"
      ? `- ${markdownName(match.identity.nativeToolName)} — ${summaryDescription(match.description)}`
      : `- ${markdownName(match.identity.nativeToolName)}`,
  );
  return renderPseudoXmlElement(
    "server",
    renderPseudoXmlElement("tools", lines.join("\n"), {
      format: "markdown",
      detail,
    }),
    attributes,
  );
}

function renderUnavailable(result: McpReferenceResult): readonly string[] {
  return (result.unavailableServers ?? []).map((server) =>
    renderPseudoXmlEmptyElement("server", {
      id: server.serverId,
      status: server.status,
      suggested_action: server.suggestedAction,
    }),
  );
}

function renderNotice(
  detail: ReferenceDetail,
  returned: number,
  matchesOmitted: number,
  hardLimit: boolean,
): string | undefined {
  const lines: string[] = [];
  if (detail !== "full" && returned > 0) {
    lines.push(
      hardLimit
        ? "The matching tool schema exceeded the single-tool output limit and was omitted."
        : `Schemas for ${returned} returned tool(s) were omitted to fit the output budget.`,
      "Query one exact tool name, with serverIds when names overlap, to reveal its full JSON Schema.",
    );
  }
  if (detail === "names" && returned > 0) {
    lines.push(`Descriptions for ${returned} returned tool(s) were also omitted.`);
  }
  if (matchesOmitted > 0) {
    lines.push(
      `${matchesOmitted} additional matching tool(s) were omitted by maxResults or the output budget.`,
    );
  }
  return lines.length > 0 ? renderPseudoXmlElement("notice", lines.join("\n")) : undefined;
}

function renderProjection(
  result: McpReferenceResult,
  matches: readonly McpReferenceMatch[],
  detail: ReferenceDetail,
  hardLimit = false,
): string {
  const returned = matches.length;
  const matchesOmitted = Math.max(0, result.matchedCount - returned);
  const schemasOmitted = detail === "full" ? 0 : returned;
  const descriptionsOmitted = detail === "names" ? returned : 0;
  const notice = renderNotice(detail, returned, matchesOmitted, hardLimit);
  const body = [
    ...groupMatches(matches).map((group) => renderServer(group, detail)),
    ...renderUnavailable(result),
    ...(notice ? [notice] : []),
  ].join("\n");
  return renderPseudoXmlElement("mcp_reference", body, {
    version: "1",
    detail,
    matched: String(result.matchedCount),
    returned: String(returned),
    ...(schemasOmitted > 0 ? { schemas_omitted: String(schemasOmitted) } : {}),
    ...(descriptionsOmitted > 0 ? { descriptions_omitted: String(descriptionsOmitted) } : {}),
    ...(matchesOmitted > 0 ? { matches_omitted: String(matchesOmitted) } : {}),
    ...(notice ? { truncated: "true" } : {}),
  });
}

/** Model-facing, budget-aware projection; the structured result remains the internal fact. */
export function projectMcpReferenceForModel(
  result: McpReferenceResult,
  options: McpReferenceProjectionOptions = {},
): string {
  const outputBytes = options.outputBytes ?? MCP_CONTRACT_LIMITS.referenceOutputBytes;
  const singleToolOutputBytes =
    options.singleToolOutputBytes ?? MCP_CONTRACT_LIMITS.referenceSingleToolOutputBytes;
  const matches = result.matches;
  const full = renderProjection(result, matches, "full");
  if (matches.length === 1) {
    return byteLength(full) <= singleToolOutputBytes
      ? full
      : renderProjection(result, matches, "summary", true);
  }
  if (byteLength(full) <= outputBytes) return full;
  const summary = renderProjection(result, matches, "summary");
  if (byteLength(summary) <= outputBytes) return summary;
  const names = renderProjection(result, matches, "names");
  if (byteLength(names) <= outputBytes) return names;
  for (let count = Math.max(0, matches.length - 1); count >= 0; count -= 1) {
    const partial = renderProjection(result, matches.slice(0, count), "names");
    if (byteLength(partial) <= outputBytes) return partial;
  }
  return renderProjection(result, [], "names");
}
