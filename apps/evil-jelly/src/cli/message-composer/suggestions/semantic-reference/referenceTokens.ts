import {
  type McpPromptToken,
  type MemoryPromptToken,
  type PromptDocument,
  promptTokens,
  type SkillPromptToken,
} from "../../../../shared/model/prompt/promptDocument";

export function skillTokensFromDocument(document: PromptDocument): SkillPromptToken[] {
  const seen = new Set<string>();
  return promptTokens(document, "skill").filter((token) => {
    if (seen.has(token.qualifiedName)) {
      return false;
    }
    seen.add(token.qualifiedName);
    return true;
  });
}

export function mcpTokensFromDocument(document: PromptDocument): McpPromptToken[] {
  const seen = new Set<string>();
  return promptTokens(document, "mcp").filter((token) => {
    if (seen.has(token.serverId)) return false;
    seen.add(token.serverId);
    return true;
  });
}

export function memoryTokensFromDocument(document: PromptDocument): MemoryPromptToken[] {
  const seen = new Set<string>();
  return promptTokens(document, "memory").filter((token) => {
    if (seen.has(token.memoryId)) return false;
    seen.add(token.memoryId);
    return true;
  });
}
