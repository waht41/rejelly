import { renderPseudoXmlElement } from "../../../shared/model/prompt/pseudoXml";

const HEADER = "## MCP servers\n\nConfigured MCP servers available for discovery:";
const FOOTER =
  "Use `mcp_reference` to load matching native tool descriptions and input schemas; query `*` " +
  "lists visible tools. Broad results may omit schemas; query one exact tool name to reveal its " +
  'full JSON Schema. A server is callable only when `callable="true"`. Follow its ' +
  "`suggested_action`; use `mcp_request` for `request_access`, `reload`, or a " +
  "relevant non-callable match instead of asking the user to run a command.";

/** Names-only projection; transport details and secrets never enter the model prompt. */
export function renderMcpServerCatalog(serverIds: readonly string[]): string {
  const visibleServerIds = [...new Set(serverIds)].sort();
  if (visibleServerIds.length === 0) return "";
  const lines = [HEADER, ...visibleServerIds.map((serverId) => `- ${serverId}`), "", FOOTER];
  return renderPseudoXmlElement("available_mcp_servers", lines.join("\n"));
}
