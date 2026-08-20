import { renderPseudoXmlElement } from "../../../shared/model/prompt/pseudoXml";

const HEADER = "## MCP servers\n\nConfigured MCP servers available for discovery:";
const FOOTER =
  "Use `mcp_reference` to load matching native tool descriptions and input schemas. " +
  "A reference match is callable only when its `callable` field is true.";

/** Names-only projection; transport details and secrets never enter the model prompt. */
export function renderMcpServerCatalog(serverIds: readonly string[]): string {
  const visibleServerIds = [...new Set(serverIds)].sort();
  if (visibleServerIds.length === 0) return "";
  const lines = [HEADER, ...visibleServerIds.map((serverId) => `- ${serverId}`), "", FOOTER];
  return renderPseudoXmlElement("available_mcp_servers", lines.join("\n"));
}
