import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import {
  type McpServerSettings,
  McpServerSettingsSchema,
  type McpSettingsFile,
  McpSettingsFileSchema,
} from "../../../domains/mcp/configuration/configuration";
import { validateUserMcpServerId } from "../../../domains/mcp/contracts";
import {
  resolveUserSettingsPath,
  SETTINGS_FILE_REL_PATH,
} from "../../../shared/configuration/settings";
import { getErrnoCode } from "../../../shared/foundation/errno";
import { parseJsonc } from "../../../shared/foundation/jsonc";

export type McpPersistentScope = "user" | "project";

export function resolveMcpSettingsPath(scope: McpPersistentScope, workspaceRoot: string): string {
  return scope === "user"
    ? resolveUserSettingsPath()
    : path.join(workspaceRoot, SETTINGS_FILE_REL_PATH);
}

interface SettingsDocument {
  readonly filePath: string;
  readonly raw: string;
  readonly mcp: McpSettingsFile;
}

function readSettingsDocument(scope: McpPersistentScope, workspaceRoot: string): SettingsDocument {
  const filePath = resolveMcpSettingsPath(scope, workspaceRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") raw = "{}\n";
    else {
      throw new Error(
        `MCP ${scope} settings ${filePath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (error) {
    throw new Error(
      `MCP ${scope} settings ${filePath} is not valid JSON(C): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`MCP ${scope} settings ${filePath} must contain a JSON object.`);
  }
  const root = parsed as Record<string, unknown>;
  const result = McpSettingsFileSchema.safeParse(root.mcp ?? {});
  if (!result.success) {
    throw new Error(`MCP ${scope} settings ${filePath} failed validation: ${result.error.message}`);
  }
  return { filePath, raw, mcp: result.data };
}

export function readMcpSettingsScope(
  scope: McpPersistentScope,
  workspaceRoot: string,
): McpSettingsFile {
  return readSettingsDocument(scope, workspaceRoot).mcp;
}

const formattingOptions = Object.freeze({ insertSpaces: true, tabSize: 2, eol: "\n" });

function atomicWrite(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let mode: number | undefined;
  try {
    mode = fs.statSync(filePath).mode;
  } catch (error) {
    if (getErrnoCode(error) !== "ENOENT") throw error;
  }
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", mode === undefined ? 0o600 : mode);
    fs.writeFileSync(descriptor, text, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Keep the original write error.
    }
    throw error;
  }
}

function validateEditedMcp(raw: string, scope: McpPersistentScope, filePath: string): void {
  const parsed = parseJsonc(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`MCP ${scope} settings ${filePath} must contain a JSON object.`);
  }
  const result = McpSettingsFileSchema.safeParse((parsed as Record<string, unknown>).mcp ?? {});
  if (!result.success) {
    throw new Error(
      `MCP ${scope} settings ${filePath} failed validation after edit: ${result.error.message}`,
    );
  }
}

function editMcpPath(
  scope: McpPersistentScope,
  workspaceRoot: string,
  jsonPath: readonly (string | number)[],
  value: unknown,
): string {
  const document = readSettingsDocument(scope, workspaceRoot);
  const edits = modify(document.raw, [...jsonPath], value, { formattingOptions });
  const updated = applyEdits(document.raw, edits);
  validateEditedMcp(updated, scope, document.filePath);
  atomicWrite(document.filePath, updated.endsWith("\n") ? updated : `${updated}\n`);
  return document.filePath;
}

function assertUserServerId(serverId: string): string {
  const result = validateUserMcpServerId(serverId);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

export function addMcpServerSettings(
  scope: McpPersistentScope,
  workspaceRoot: string,
  serverId: string,
  settings: McpServerSettings,
): string {
  const id = assertUserServerId(serverId);
  const parsed = McpServerSettingsSchema.parse(settings);
  const document = readSettingsDocument(scope, workspaceRoot);
  if (document.mcp.servers?.[id] !== undefined) {
    throw new Error(`MCP server "${id}" already exists in ${scope} settings ${document.filePath}.`);
  }
  return editMcpPath(scope, workspaceRoot, ["mcp", "servers", id], parsed);
}

export function removeMcpServerSettings(
  scope: McpPersistentScope,
  workspaceRoot: string,
  serverId: string,
): string {
  const id = assertUserServerId(serverId);
  const document = readSettingsDocument(scope, workspaceRoot);
  if (document.mcp.servers?.[id] === undefined) {
    throw new Error(
      `MCP server "${id}" does not exist in ${scope} settings ${document.filePath}; the other scope was not changed.`,
    );
  }
  return editMcpPath(scope, workspaceRoot, ["mcp", "servers", id], undefined);
}

export function setMcpServerEnabled(
  scope: McpPersistentScope,
  workspaceRoot: string,
  serverId: string,
  enabled: boolean,
): string {
  const id = assertUserServerId(serverId);
  const document = readSettingsDocument(scope, workspaceRoot);
  if (document.mcp.servers?.[id] === undefined) {
    throw new Error(
      `MCP server "${id}" does not exist in ${scope} settings ${document.filePath}; the other scope was not changed.`,
    );
  }
  return editMcpPath(scope, workspaceRoot, ["mcp", "servers", id, "enabled"], enabled);
}
