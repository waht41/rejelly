/**
 * CLI tool-approval coordinator: applies session policy and delegates unresolved decisions to the
 * terminal prompt/presentation adapters.
 */

import type { AgentMode } from "../../shared/host/modeBindings";
import type {
  FsOutsideAccessPayload,
  FsWritePayload,
  McpAccessConfirmationPayload,
  McpCallConfirmationPayload,
  ShellCommandPayload,
  ToolConfirmationHandler,
  ToolConfirmationResult,
  WriteActionType,
} from "../../shared/host/toolConfirmationBindings";
import { recordActiveToolDetail } from "../../shared/tool-observation/invocationContext";
import { useOutputStore } from "../conversation-display/useOutputStore";
import type {
  DecisionOption,
  OperatorDecision,
  OperatorDecisionSession,
} from "../operator-decision/model";
import { createOperatorDecision } from "../operator-decision/operatorDecision";
import { editContentInExternalEditor } from "./externalEditor";
import { classifyShellCommand, isSimpleCommand } from "./shellCommandPolicy";

const ACTION_UI_MAP: Record<WriteActionType, DecisionOption> = {
  accept: { key: "y", label: "Accept", value: "accept" },
  reject: { key: "n", label: "Reject", value: "reject" },
  edit: { key: "e", label: "Edit in editor", value: "edit" },
  retry: { key: "r", label: "Retry with feedback", value: "retry" },
};

function uniqueWriteActions(actions: WriteActionType[]): WriteActionType[] {
  const seen = new Set<WriteActionType>();
  const out: WriteActionType[] = [];
  for (const a of actions) {
    if (!seen.has(a)) {
      seen.add(a);
      out.push(a);
    }
  }
  return out;
}

export type CreateToolApprovalOptions = {
  /**
   * Unmount Ink and release the TTY before running an external editor, then remount after.
   * Omit only in tests or non-Ink hosts; required for correct vim + Ink coexistence.
   */
  suspendInkForExternalProcess?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Initial session auto-allow flags by operation kind. */
  initialAutoAllow?: Partial<AutoAllowPolicy>;
  /** Initial shell command prefixes allowed for session auto-accept. */
  initialShellAutoAllowPrefixes?: string[];
  /**
   * Reads the current session mode. Injected from the upper layer (the CLI wires it to the mode
   * store); defaults to "normal". Mode governs the ambiguous (confirm) shell tier and fs writes
   * (create/edit/delete auto-accept in "auto"); read-only commands auto-run and irreversible
   * shell commands are confirmed in every mode.
   */
  getMode?: () => AgentMode;
  /** Operator-facing decision capability; defaults to the terminal decision surface. */
  decision?: OperatorDecision;
};

type AutoAllowPolicy = {
  create: boolean;
  edit: boolean;
  delete: boolean;
};

/**
 * Flatten a path for an `[Auto-allowed]` notice. The notice is a headline —
 * logged with `oneLine`, so the renderer truncates it to the terminal width —
 * and truncation applies per line, so embedded newlines have to go here.
 */
function forNotice(target: string): string {
  return target.replace(/\s*\n\s*/g, " ").trim();
}

/**
 * Committed to history as a single truncated row, not wrapped.
 *
 * A shell notice says only *why* the command ran without asking. It deliberately
 * does not repeat the command: the running-tool headline shows it while it runs
 * and the tool block below names it again once it finishes, so including it here
 * put the same long line on screen twice in a row.
 */
function logNotice(message: string): void {
  useOutputStore.getState().logSystem(message, { oneLine: true });
}

function normalizeShellPrefix(prefix: string): string {
  return prefix.trim().replace(/\s+/g, " ");
}

function commandMatchesPrefix(command: string, prefix: string): boolean {
  const normalizedCommand = normalizeShellPrefix(command);
  const normalizedPrefix = normalizeShellPrefix(prefix);
  if (!normalizedPrefix) {
    return false;
  }
  return (
    normalizedCommand === normalizedPrefix || normalizedCommand.startsWith(`${normalizedPrefix} `)
  );
}

function deriveAutoAllowPrefix(command: string): string {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]} ${parts[1]}`;
  }
  return parts[0] ?? "";
}

function tryAutoAllowFsWrite(
  params: FsWritePayload,
  policy: AutoAllowPolicy,
  getMode: () => AgentMode,
): ToolConfirmationResult | null {
  if (params.outsideWorkspace) {
    return null;
  }
  // Inside-workspace fs writes are diff-reviewed, so "auto" mode accepts them. Outside-workspace
  // writes have a wider boundary and stay manually gated.
  if (getMode() === "auto") {
    logNotice(`[Auto-allowed] ${params.kind} (auto mode) → ${forNotice(params.filePath)}`);
    return { action: "accept" };
  }
  if (!policy[params.kind]) {
    return null;
  }
  logNotice(`[Auto-allowed] ${params.kind} → ${forNotice(params.filePath)}`);
  return { action: "accept" };
}

async function confirmOutsideAccess(
  params: FsOutsideAccessPayload,
  decision: OperatorDecisionSession,
): Promise<ToolConfirmationResult> {
  const menuOptions: DecisionOption[] = [
    { key: "y", label: "Allow", value: "accept" },
    { key: "n", label: "Reject", value: "reject" },
  ];
  useOutputStore
    .getState()
    .setPhase("awaiting_user", `outside ${params.mode} → ${params.targetPath}`);
  const selected = await decision.requestChoice({
    message: `Allow ${params.mode} outside workspace?\n${params.targetPath}\n\nApprove directory for this session:\n${params.approveDir}`,
    options: menuOptions,
    cancelValue: "reject",
  });
  useOutputStore.getState().resumeWork("Running…");
  return selected === "accept" ? { action: "accept" } : { action: "reject" };
}

async function confirmMcpCall(
  params: McpCallConfirmationPayload,
  decision: OperatorDecisionSession,
): Promise<ToolConfirmationResult> {
  const identity = `${params.tool.serverId}/${params.tool.nativeToolName}`;
  useOutputStore.getState().setPhase("awaiting_user", `MCP → ${identity}`);
  const selected = await decision.requestChoice({
    message: `Allow MCP tool ${identity}?\nArguments:\n${JSON.stringify(params.arguments, null, 2)}`,
    options: [
      { key: "y", label: "Allow once", value: "accept" },
      { key: "s", label: "Allow this tool for this session", value: "accept_session" },
      { key: "A", label: "Always allow this tool in this workspace", value: "accept_always" },
      { key: "n", label: "Reject", value: "reject" },
    ],
    cancelValue: "reject",
  });
  useOutputStore.getState().resumeWork("Running…");
  if (selected === "accept_session") return { action: "accept", scope: "session" };
  if (selected === "accept_always") return { action: "accept", scope: "always" };
  return selected === "accept" ? { action: "accept", scope: "once" } : { action: "reject" };
}

async function confirmMcpAccess(
  params: McpAccessConfirmationPayload,
  decision: OperatorDecisionSession,
): Promise<ToolConfirmationResult> {
  useOutputStore.getState().setPhase("awaiting_user", `MCP access → ${params.serverId}`);
  const trustLine = params.requiresTrust
    ? "\nThis also trusts the exact workspace configuration fingerprint."
    : "";
  const reasonLine = params.reason ? `\nReason: ${params.reason}` : "";
  const selected = await decision.requestChoice({
    message:
      `Allow MCP server ${params.serverId}?\n` +
      `Source: ${params.source}\nFingerprint: ${params.configFingerprint}` +
      trustLine +
      reasonLine,
    options: [
      { key: "y", label: "Allow for this session", value: "accept" },
      { key: "A", label: "Always allow this server in this workspace", value: "accept_always" },
      { key: "n", label: "Reject", value: "reject" },
    ],
    cancelValue: "reject",
  });
  useOutputStore.getState().resumeWork("Running…");
  if (selected === "accept_always") return { action: "accept", scope: "always" };
  return selected === "accept" ? { action: "accept", scope: "session" } : { action: "reject" };
}

type ShellAutoAllowCheck = {
  result: ToolConfirmationResult | null;
  declaredReason: string;
  risk: ReturnType<typeof classifyShellCommand>;
};

function tryAutoAllowShellCommand(
  params: ShellCommandPayload,
  shellAutoAllowPrefixes: Set<string>,
  getMode: () => AgentMode,
): ShellAutoAllowCheck {
  const risk = classifyShellCommand(params.command);
  // Read-only commands run in every mode; irreversible (block) ones are never auto-run.
  if (risk === "auto") {
    logNotice("[Auto-allowed] safe shell (read-only)");
    return { result: { action: "accept" }, declaredReason: "", risk };
  }

  // Learned prefixes only match a single simple command (no chaining/substitution/redirect)
  // and never override a block-tier command (irreversible/privileged/outbound).
  if (risk !== "block" && isSimpleCommand(params.command)) {
    for (const prefix of shellAutoAllowPrefixes) {
      if (commandMatchesPrefix(params.command, prefix)) {
        logNotice(`[Auto-allowed] shell prefix: ${prefix}`);
        return { result: { action: "accept" }, declaredReason: "", risk };
      }
    }
  }

  const declaredSafety = params.declaredSafety;
  if (
    risk === "confirm" &&
    getMode() === "auto" &&
    (declaredSafety === "read_only" || declaredSafety === "reversible")
  ) {
    const why = params.reason ? ` — ${params.reason}` : "";
    logNotice(`[Auto-allowed] declared ${declaredSafety}${why}`);
    return { result: { action: "accept" }, declaredReason: "", risk };
  }

  return { result: null, declaredReason: params.reason ?? "", risk };
}

async function confirmShellCommand(
  params: ShellCommandPayload,
  declaredReason: string,
  risk: ReturnType<typeof classifyShellCommand>,
  shellAutoAllowPrefixes: Set<string>,
  decision: OperatorDecisionSession,
): Promise<ToolConfirmationResult> {
  const actions = uniqueWriteActions(
    params.supportedActions?.length ? params.supportedActions : ["accept", "reject"],
  );
  const menuOptions: DecisionOption[] = actions.map((a) => ACTION_UI_MAP[a]);
  const blocked = risk === "block";
  const suggestedPrefix = deriveAutoAllowPrefix(params.command);
  if (actions.includes("accept") && !blocked && suggestedPrefix.length > 0) {
    menuOptions.push({
      key: "A",
      label: `Accept future shell commands with prefix: ${suggestedPrefix}`,
      value: "accept_shell_prefix",
    });
  }

  const cwd = params.cwd?.trim() ? params.cwd.trim() : "workspace root";
  useOutputStore.getState().setPhase("awaiting_user", `shell → ${cwd}`);
  if (blocked) {
    logNotice(
      "[Auto-allow] Disabled for this command (irreversible/privileged/outbound operation).",
    );
  }
  const safetyNote = declaredReason ? `\n⚠ ${declaredReason}` : "";
  const selected = await decision.requestChoice({
    message: `Run shell command in ${cwd}?${safetyNote}\n> ${params.command}`,
    options: menuOptions,
    ...(actions.includes("reject") ? { cancelValue: "reject" } : {}),
  });
  useOutputStore.getState().resumeWork("Running…");

  if (selected === "accept_shell_prefix") {
    shellAutoAllowPrefixes.add(suggestedPrefix);
    logNotice(`[Auto-allow] Enabled shell prefix: ${suggestedPrefix}`);
    return { action: "accept" };
  }
  return selected === "accept" ? { action: "accept" } : { action: "reject" };
}

async function confirmFsWrite(
  params: FsWritePayload,
  policy: AutoAllowPolicy,
  suspendInkForExternalProcess: CreateToolApprovalOptions["suspendInkForExternalProcess"],
  decision: OperatorDecisionSession,
): Promise<ToolConfirmationResult> {
  const {
    kind,
    filePath,
    unifiedDiff,
    proposedContent,
    reviewCaption,
    supportedActions = ["accept", "reject"],
  } = params;

  const actions = uniqueWriteActions(
    supportedActions.length > 0 ? supportedActions : ["accept", "reject"],
  );
  const menuOptions: DecisionOption[] = actions.map((a) => ACTION_UI_MAP[a]);
  if (actions.includes("accept") && !params.outsideWorkspace) {
    menuOptions.push({
      key: "A",
      label: "Accept all future writes in this session",
      value: "accept_all_session",
    });
  }

  const outsideLabel = params.outsideWorkspace ? " outside workspace" : "";
  useOutputStore.getState().setPhase("awaiting_user", `${kind}${outsideLabel} → ${filePath}`);
  // Commit the reviewed diff to <Static> history instead of the transient view: it stays in
  // scrollback for later review, and the dynamic frame stays shorter than the viewport, so Ink
  // never enters its overflow full-repaint path while the menu is up.
  useOutputStore.getState().logDiff({
    text: unifiedDiff,
    ...(reviewCaption?.trim() ? { caption: reviewCaption.trim() } : {}),
    captionTitle: "Proposed changes",
  });
  const selected = await decision.requestChoice({
    message: `Allow ${kind}${outsideLabel} ${filePath}?`,
    options: menuOptions,
    ...(actions.includes("reject") ? { cancelValue: "reject" } : {}),
  });
  useOutputStore.getState().resumeWork("Running…");

  if (selected === "accept_all_session") {
    policy.create = true;
    policy.edit = true;
    policy.delete = true;
    logNotice("[Auto-allow] Enabled for the rest of this session.");
    return { action: "accept" };
  }

  if (selected === "edit") {
    const runEdit = () => editContentInExternalEditor(proposedContent, filePath);
    const modifiedContent = suspendInkForExternalProcess
      ? await suspendInkForExternalProcess(runEdit)
      : await runEdit();
    useOutputStore.getState().resumeWork("Running…");
    return { action: "edit", modifiedContent };
  }

  if (selected === "retry") {
    useOutputStore.getState().setPhase("awaiting_user", "Waiting for review comments…");
    const feedback = await decision.requestText("Review comments: ");
    useOutputStore.getState().resumeWork("Running…");
    return { action: "retry", feedback };
  }

  if (selected === "accept") {
    return { action: "accept" };
  }

  return { action: "reject" };
}

export function createToolApproval(
  options: CreateToolApprovalOptions = {},
): ToolConfirmationHandler {
  const policy: AutoAllowPolicy = {
    create: options.initialAutoAllow?.create ?? false,
    edit: options.initialAutoAllow?.edit ?? false,
    delete: options.initialAutoAllow?.delete ?? false,
  };
  const shellAutoAllowPrefixes = new Set(
    (options.initialShellAutoAllowPrefixes ?? [])
      .map((p) => normalizeShellPrefix(p))
      .filter((p) => p.length > 0),
  );

  const getMode = options.getMode ?? (() => "normal" as AgentMode);
  const decision = options.decision ?? createOperatorDecision();

  const confirmTool: ToolConfirmationHandler = async (params) => {
    if (params.type === "shell_command") {
      const autoAllow = tryAutoAllowShellCommand(params, shellAutoAllowPrefixes, getMode);
      if (autoAllow.result) {
        return autoAllow.result;
      }
      return decision.run((session) =>
        confirmShellCommand(
          params,
          autoAllow.declaredReason,
          autoAllow.risk,
          shellAutoAllowPrefixes,
          session,
        ),
      );
    }
    if (params.type === "fs_outside_access") {
      return decision.run((session) => confirmOutsideAccess(params, session));
    }
    if (params.type === "mcp_access") {
      if (getMode() === "auto" && !params.requiresTrust) {
        logNotice(`[Auto-allowed] MCP server ${params.serverId} for this session (auto mode)`);
        return { action: "accept", scope: "session" };
      }
      return decision.run((session) => confirmMcpAccess(params, session));
    }
    if (params.type === "mcp_call") {
      if (getMode() === "auto") {
        logNotice(
          `[Auto-allowed] MCP tool ${params.tool.serverId}/${params.tool.nativeToolName} (auto mode)`,
        );
        return { action: "accept", scope: "once" };
      }
      return decision.run((session) => confirmMcpCall(params, session));
    }

    const autoAllow = tryAutoAllowFsWrite(params, policy, getMode);
    if (autoAllow) {
      recordActiveToolDetail({
        type: "diff",
        text: params.unifiedDiff,
        ...(params.reviewCaption?.trim() ? { caption: params.reviewCaption.trim() } : {}),
        phase: "proposed",
        presentation: "inline",
      });
      return autoAllow;
    }
    recordActiveToolDetail({
      type: "diff",
      text: params.unifiedDiff,
      ...(params.reviewCaption?.trim() ? { caption: params.reviewCaption.trim() } : {}),
      phase: "proposed",
      presentation: "expanded",
    });
    return decision.run((session) =>
      confirmFsWrite(params, policy, options.suspendInkForExternalProcess, session),
    );
  };
  return confirmTool;
}
