/**
 * Host binding stubs for non-router entry points.
 */

import type { EvilJellyBindings } from "../../../shared/host/bindings";
import { classifyShellCommand } from "../../runtime/shellCommandPolicy";

export interface StubHostBindingsOptions {
  /** Return accept for every confirmWrite request (used by test/batch flows). */
  autoAcceptWrite?: boolean;
  /** Accept shell commands classified as read-only/auto; reject writes and higher-risk shell commands. */
  allowReadonlyShellCommands?: boolean;
  /** Pre-seeded getInput values for headless loops; falls back to empty string. */
  scriptedInputs?: string[];
}

function createStubHostBindings(
  logPrefix: string,
  options: StubHostBindingsOptions = {},
): EvilJellyBindings {
  const {
    autoAcceptWrite = false,
    allowReadonlyShellCommands = false,
    scriptedInputs = [],
  } = options;
  const inputQueue = [...scriptedInputs];
  return {
    getInput: async () => ({ text: inputQueue.shift() ?? "" }),
    printOut: (message: string) => {
      process.stdout.write(message);
    },
    logUserMessage: (message: string) => {
      console.log(`[${logPrefix}][user] ${message}`);
    },
    logAssistantMessage: (message: string) => {
      console.log(`[${logPrefix}][assistant] ${message}`);
    },
    // No live view to attribute output to, so shell chunks just go to stdout as
    // they arrive — which is what a headless run wants anyway.
    appendToolOutput: (_toolCallId: string, chunk: string) => {
      process.stdout.write(chunk);
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
    confirmTool: async (params) => {
      if (autoAcceptWrite) {
        if (params.type === "fs_write") {
          console.log(`[${logPrefix}] confirmWrite auto-accept: ${params.kind} ${params.filePath}`);
        } else if (params.type === "fs_outside_access") {
          console.log(
            `[${logPrefix}] confirmWrite auto-accept: outside ${params.mode} ${params.targetPath}`,
          );
        } else {
          console.log(`[${logPrefix}] confirmWrite auto-accept: shell ${params.command}`);
        }
        return { action: "accept" };
      }
      if (
        allowReadonlyShellCommands &&
        params.type === "shell_command" &&
        classifyShellCommand(params.command) === "auto"
      ) {
        console.log(`[${logPrefix}] confirmWrite auto-accept readonly shell: ${params.command}`);
        return { action: "accept" };
      }
      if (params.type === "fs_write") {
        console.warn(`[${logPrefix}] confirmWrite auto-reject: ${params.kind} ${params.filePath}`);
      } else if (params.type === "fs_outside_access") {
        console.warn(
          `[${logPrefix}] confirmWrite auto-reject: outside ${params.mode} ${params.targetPath}`,
        );
      } else {
        console.warn(`[${logPrefix}] confirmWrite auto-reject: shell ${params.command}`);
      }
      return { action: "reject" };
    },
    requestChoice: async (_message, options) => {
      const value = options[0]?.value ?? "";
      console.log(`[${logPrefix}] requestChoice → first option (${value})`);
      return value;
    },
  };
}

/**
 * Stub bindings for headless CLI commands (`summary`, future batch modes).
 */
export function createBackgroundHostBindings(
  options: StubHostBindingsOptions = {},
): EvilJellyBindings {
  return createStubHostBindings("cli", {
    allowReadonlyShellCommands: true,
    ...options,
  });
}
