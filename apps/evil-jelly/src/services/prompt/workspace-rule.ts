/**
 * Read optional Codex-style workspace instructions for the interactive agent.
 */

import fs from "node:fs";
import path from "node:path";
import { renderPseudoXmlElement } from "../../shared/lib/pseudoXml";

const AGENTS_RULE_FILES = ["AGENTS.override.md", "AGENTS.md"] as const;

interface WorkspaceRule {
  fileName: (typeof AGENTS_RULE_FILES)[number];
  markdown: string;
}

/** Resolve the first non-empty instruction file using Codex's same-directory precedence. */
function resolveWorkspaceRule(workspaceRoot: string): WorkspaceRule | undefined {
  for (const fileName of AGENTS_RULE_FILES) {
    const rulePath = path.join(workspaceRoot, fileName);
    try {
      const stat = fs.statSync(rulePath);
      if (!stat.isFile()) {
        continue;
      }
      const markdown = fs.readFileSync(rulePath, "utf-8").trim();
      if (markdown.length > 0) {
        return { fileName, markdown };
      }
    } catch {
      // Missing and unreadable candidates do not prevent fallback to the next filename.
    }
  }
  return undefined;
}

/**
 * Reads `AGENTS.override.md`, falling back to `AGENTS.md`, under `workspaceRoot`.
 * Returns empty string when neither candidate is readable and non-empty.
 */
export function readWorkspaceRuleMarkdown(workspaceRoot: string): string {
  return resolveWorkspaceRule(workspaceRoot)?.markdown ?? "";
}

/**
 * Builds an XML-delimited instruction block injected into the agent's system prompt.
 */
export function buildWorkspaceRuleInstructionBlock(workspaceRoot: string): string {
  const rule = resolveWorkspaceRule(workspaceRoot);
  if (!rule) {
    return "";
  }
  return renderPseudoXmlElement(
    "workspace-instructions",
    [
      "Workspace-provided instructions. Apply these rules while solving the request.",
      rule.markdown,
    ].join("\n"),
    { source: rule.fileName },
  );
}
