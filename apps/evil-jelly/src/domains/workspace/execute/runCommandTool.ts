/**
 * run_command: generic shell command in workspace cwd. Host progress via augmentTool + withToolLogger.
 */

import type { ToolDefinition } from "@rejelly/core";
import { getContextSignal } from "@rejelly/core";
import { z } from "zod";
import { getWorkspaceFiles } from "../../../shared/fs-policy/workspace-files";
import { getBinding } from "../../../shared/host/context";
import { registerInterruptibleTask } from "../../../shared/task-interruption/taskStack";
import { getActiveToolCall } from "../../../shared/tool-observation/invocationContext";
import { executeShellCommand, getShellEnvironmentSummary } from "./executeShellCommand";

const runCommandParameters = z.object({
  command: z
    .string()
    .min(1)
    .max(8000)
    .describe("Single shell command to execute (e.g. pnpm install dayjs, pnpm run lint)."),
  cwd: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe("Optional working directory. Defaults to the workspace root."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(1_800_000)
    .optional()
    .describe(
      "Optional hard timeout in milliseconds. Defaults to 180000 (3 minutes); maximum 1800000 (30 minutes).",
    ),
  declaredSafety: z
    .enum(["read_only", "reversible", "needs_confirmation", "dangerous"])
    .describe(
      "Model-declared safety: read_only prints/inspects only; reversible may write but is easy to undo; needs_confirmation should ask first; dangerous is destructive, privileged, or outbound.",
    ),
  reason: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "One short reason for the declared safety level. Shown in logs or the confirmation prompt.",
    ),
});

function mergeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const definedSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (definedSignals.length === 0) {
    return undefined;
  }
  if (definedSignals.length === 1) {
    return definedSignals[0];
  }
  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };
  for (const signal of definedSignals) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    signal.addEventListener("abort", () => abortFrom(signal), { once: true });
  }
  return controller.signal;
}

export const RunCommandTool: ToolDefinition<typeof runCommandParameters> = {
  name: "run_command",
  description:
    "Run a shell command in workspace root by default (tests, tsc, lint). " +
    "Use cwd to execute in another directory. " +
    "Commands run through the host platform shell; on Windows this is PowerShell syntax, not cmd.exe or Unix sh syntax. " +
    "Prefer this when you need a targeted check beyond the automatic post-edit verification.",
  parameters: runCommandParameters,
  handler: async ({ command, cwd, timeoutMs, declaredSafety, reason }) => {
    const policy = getWorkspaceFiles();
    const resolvedCwdPath = policy.classifyPath(cwd ?? ".");
    try {
      const stat = await policy.statResolved(resolvedCwdPath);
      if (!stat.isDirectory()) {
        return `Command cwd is not a directory: ${resolvedCwdPath.displayPath}`;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to inspect command cwd: ${message}`;
    }
    const resolvedCwd = resolvedCwdPath.abs;
    const host = getBinding();

    const decision = await host.confirmTool({
      type: "shell_command",
      command,
      cwd,
      declaredSafety,
      reason,
      supportedActions: ["accept", "reject"],
    });
    if (decision.action !== "accept") {
      return "Command execution denied by user.";
    }
    const contextSignal = getContextSignal();
    const localAbortController = new AbortController();
    const unregisterTask = registerInterruptibleTask({
      type: "tool_execution",
      name: `run_command: ${command.slice(0, 60)}`,
      abort: (reason) => {
        if (!localAbortController.signal.aborted) {
          localAbortController.abort(new Error(reason));
        }
      },
    });
    const signal = mergeAbortSignals(contextSignal, localAbortController.signal);
    // Live output goes to this call's slot in the host's transient tail view, not
    // to printOut — that is the assistant's stream, and anything written there is
    // committed to scrollback in full and rendered as if the model had said it.
    // With no handle or no live view the chunks are simply dropped; the collapsed
    // block still carries the whole result.
    const toolCall = getActiveToolCall();
    const onOutput =
      toolCall && host.appendToolOutput
        ? (chunk: string) => host.appendToolOutput?.(toolCall.id, chunk)
        : undefined;
    const result = await executeShellCommand(
      {
        command,
        cwd: resolvedCwd,
        timeoutMs,
        signal,
      },
      onOutput,
    ).finally(() => {
      unregisterTask();
    });
    if (result.error?.code === "EABORTED") {
      const output = result.output?.trim().length ? result.output : "(no output)";
      return `exitCode=null status=aborted\n${output}\nCommand aborted by user (/stop or Esc).`;
    }
    if (result.error?.code === "ETIMEDOUT") {
      const output = result.output?.trim().length ? result.output : "(no output)";
      return `exitCode=null status=timed_out ${getShellEnvironmentSummary()}\n${output}\nCommand exceeded the hard timeout and its process tree was terminated.`;
    }
    const status = result.exitCode === 0 ? "ok" : "failed";
    const exitCode = result.exitCode === null ? "null" : String(result.exitCode);
    const head = `exitCode=${exitCode} status=${status} ${getShellEnvironmentSummary()}\n`;
    return head + result.output;
  },
};
