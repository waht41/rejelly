import type { ToolConfirmationHandler } from "../AgentShared";

/** Human or policy decision boundary for tool operations that require confirmation. */
export interface ToolConfirmationBindings {
  confirmTool: ToolConfirmationHandler;
}
