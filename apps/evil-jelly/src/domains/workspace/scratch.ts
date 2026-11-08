import { randomUUID } from "node:crypto";
import { equipResource, expectResource } from "@rejelly/core";
import { getAgentScratchDir, getWorkspaceRoot } from "../../shared/fs-policy/workspace-context";

const AGENT_SCRATCH_KEY = "evil-jelly:agent-scratch";

interface AgentScratch {
  workspaceRoot: string;
  sessionId: string;
  directory: string;
}

/** Bind a stable scratch identity to the conversation; allocation does not create any files. */
export async function equipAgentScratchDir(sessionId?: string): Promise<string> {
  const workspaceRoot = getWorkspaceRoot();
  const existing = expectResource<AgentScratch>(AGENT_SCRATCH_KEY, { optional: true });
  if (
    existing?.workspaceRoot === workspaceRoot &&
    (sessionId === undefined || existing.sessionId === sessionId)
  ) {
    return existing.directory;
  }
  const scratch = await equipResource<AgentScratch>(AGENT_SCRATCH_KEY, {
    create: async () => {
      const identity = sessionId ?? randomUUID();
      return {
        workspaceRoot,
        sessionId: identity,
        directory: getAgentScratchDir(identity, workspaceRoot),
      };
    },
    deps: [workspaceRoot, sessionId],
    expose: true,
  });
  return scratch.directory;
}
