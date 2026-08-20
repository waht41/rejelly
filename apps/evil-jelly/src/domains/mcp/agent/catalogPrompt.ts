import { renderPseudoXmlElement } from "../../../shared/model/prompt/pseudoXml";

const HEADER = "## MCP servers\n\nConfigured MCP servers available for discovery:";
const FOOTER =
  "Use `mcp_reference` to load matching native tool descriptions and input schemas; query `*` " +
  "lists visible tools. A match is callable only when `callable` is true. Follow " +
  "`unavailableServers[].suggestedAction` instead of retrying different search terms.";

/** Names-only projection; transport details and secrets never enter the model prompt. */
export function renderMcpServerCatalog(serverIds: readonly string[]): string {
  const visibleServerIds = [...new Set(serverIds)].sort();
  if (visibleServerIds.length === 0) return "";
  const lines = [HEADER, ...visibleServerIds.map((serverId) => `- ${serverId}`), "", FOOTER];
  return renderPseudoXmlElement("available_mcp_servers", lines.join("\n"));
}
