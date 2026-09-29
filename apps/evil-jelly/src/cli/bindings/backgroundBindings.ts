/**
 * Host binding stubs for non-router entry points.
 */

import type { EvilJellyBindings } from "../../shared/host/bindings";
import { textPromptInput } from "../../shared/model/prompt/promptInput";
import { classifyShellCommand } from "../tool-approval/shellCommandPolicy";

export interface BackgroundBindingsOptions {
  /** Return accept for every tool approval request (used by test/batch flows). */
  autoAcceptWrite?: boolean;
  /** Accept shell commands classified as read-only/auto; reject writes and higher-risk shell commands. */
  allowReadonlyShellCommands?: boolean;
  /** Control whether transient assistant/tool output is written before committed log events. */
  liveOutput?: "stream" | "committed-only";
  /** Pre-seeded getInput values for headless loops; falls back to empty string. */
  scriptedInputs?: string[];
}

function createStubHostBindings(
  logPrefix: string,
  options: BackgroundBindingsOptions = {},
): EvilJellyBindings {
  const {
    autoAcceptWrite = false,
    allowReadonlyShellCommands = false,
    liveOutput = "stream",
    scriptedInputs = [],
  } = options;
  const inputQueue = [...scriptedInputs];
  const streamLiveOutput = liveOutput === "stream";
  return {
    getInput: async () => textPromptInput(inputQueue.shift() ?? ""),
    printOut: (message: string) => {
      if (streamLiveOutput) process.stdout.write(message);
    },
    logUserMessage: (message: string) => {
      console.log(`[${logPrefix}][user] ${message}`);
    },
    logAssistantMessage: (message: string) => {
      console.log(`[${logPrefix}][assistant] ${message}`);
    },
    // Streaming hosts expose command chunks immediately. Committed-only hosts retain
    // complete tool output in durable observations without duplicating it on stdout.
    appendToolOutput: (_toolCallId: string, chunk: string) => {
      if (streamLiveOutput) process.stdout.write(chunk);
    },
    logToolBlock: (block) => {
      console.log(`[${logPrefix}][tool] ${block.summary}`);
    },
    logSystemEvent: (message: string) => {
      console.log(`[${logPrefix}][system] ${message}`);
    },
    onDetailUpdate: (detail: string) => {
      console.log(`[${logPrefix}][detail] ${detail}`);
    },
    requestMemoryConfirmation: async (params) => {
      console.warn(
        `[${logPrefix}] memory confirmation unavailable: ${params.operation} ${params.id}`,
      );
      return { action: "unavailable", reason: "Interactive memory confirmation is unavailable." };
    },
    confirmTool: async (params) => {
      if (autoAcceptWrite) {
        if (params.type === "fs_write") {
          console.log(`[${logPrefix}][approval] auto-accept: ${params.kind} ${params.filePath}`);
        } else if (params.type === "fs_outside_access") {
          console.log(
            `[${logPrefix}][approval] auto-accept: outside ${params.access} ${params.targetPath}`,
          );
        } else if (params.type === "shell_command") {
          console.log(`[${logPrefix}][approval] auto-accept: shell ${params.command}`);
        } else if (params.type === "mcp_access") {
          console.log(`[${logPrefix}][approval] auto-accept: MCP access ${params.serverId}`);
        } else {
          console.log(
            `[${logPrefix}][approval] auto-accept: MCP ${params.tool.serverId}/${params.tool.nativeToolName}`,
          );
        }
        return { action: "accept" };
      }
      if (
        allowReadonlyShellCommands &&
        params.type === "shell_command" &&
        classifyShellCommand(params.command) === "auto"
      ) {
        console.log(`[${logPrefix}][approval] auto-accept readonly shell: ${params.command}`);
        return { action: "accept" };
      }
      if (params.type === "fs_write") {
        console.warn(`[${logPrefix}][approval] auto-reject: ${params.kind} ${params.filePath}`);
      } else if (params.type === "fs_outside_access") {
        console.warn(
          `[${logPrefix}][approval] auto-reject: outside ${params.access} ${params.targetPath}`,
        );
      } else if (params.type === "shell_command") {
        console.warn(`[${logPrefix}][approval] auto-reject: shell ${params.command}`);
      } else if (params.type === "mcp_access") {
        console.warn(`[${logPrefix}][approval] auto-reject: MCP access ${params.serverId}`);
      } else {
        console.warn(
          `[${logPrefix}][approval] auto-reject: MCP ${params.tool.serverId}/${params.tool.nativeToolName}`,
        );
      }
      return { action: "reject" };
    },
    requestChoice: async ({ options }) => {
      const value = options[0]?.value ?? "";
      console.log(`[${logPrefix}] requestChoice → first option (${value})`);
      return value;
    },
    requestMemoryManager: async () => ({ action: "close" as const }),
    requestSkillManager: async () => ({ action: "close" as const }),
  };
}

/**
 * Stub bindings for headless CLI commands (`summary`, future batch modes).
 */
export function createBackgroundHostBindings(
  options: BackgroundBindingsOptions = {},
): EvilJellyBindings {
  return createStubHostBindings("cli", {
    allowReadonlyShellCommands: true,
    ...options,
  });
}
