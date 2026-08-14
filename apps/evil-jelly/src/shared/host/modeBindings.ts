/** Session interaction policy selected by the user. */
export type AgentMode = "normal" | "auto";

/** Current host-owned interaction mode exposed to policy-sensitive operations. */
export interface AgentModeBindings {
  getAgentMode?: () => AgentMode;
}
