/**
 * Read optional Codex-style workspace instructions for the interactive agent.
 */

import {
  getWorkspaceFsPolicy,
  type WorkspaceFsPolicy,
} from "../../shared/fs-policy/workspace-fs-policy";
import { renderPseudoXmlElement } from "../../shared/model/prompt/pseudoXml";

const AGENTS_RULE_FILES = ["AGENTS.override.md", "AGENTS.md"] as const;

interface WorkspaceRule {
  fileName: (typeof AGENTS_RULE_FILES)[number];
  markdown: string;
}

/** Resolve the first non-empty instruction file using Codex's same-directory precedence. */
async function resolveWorkspaceRule(policy: WorkspaceFsPolicy): Promise<WorkspaceRule | undefined> {
  for (const fileName of AGENTS_RULE_FILES) {
    try {
      // Rule files stay readable even when gitignored: ignoring AGENTS.override.md while
      // keeping it tracked is a Codex convention. Only the gitignore guard is relaxed;
      // sensitive-file and system-hidden checks still apply in the policy.
      const stat = await policy.stat(fileName, { kind: "read" });
      if (!stat.isFile()) {
        continue;
      }
      const markdown = (await policy.readFile(fileName)).trim();
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
 * Reads `AGENTS.override.md`, falling back to `AGENTS.md`, through the workspace FS policy.
 * Returns empty string when neither candidate is readable and non-empty.
 */
export async function readWorkspaceRuleMarkdown(
  policy: WorkspaceFsPolicy = getWorkspaceFsPolicy(),
): Promise<string> {
  return (await resolveWorkspaceRule(policy))?.markdown ?? "";
}

/**
 * Builds an XML-delimited instruction block injected into the agent's system prompt.
 */
export async function buildWorkspaceRuleInstructionBlock(
  policy: WorkspaceFsPolicy = getWorkspaceFsPolicy(),
): Promise<string> {
  const rule = await resolveWorkspaceRule(policy);
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
