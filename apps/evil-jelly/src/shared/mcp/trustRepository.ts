/** User-level MCP trust and persistent chat permissions. Never stores executable config. */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getErrnoCode } from "../foundation/errno";
import { resolveGlobalJellyDir } from "../globalPath";
import { validateMcpServerId } from "../model/mcp/serverIdentity";
import type { McpToolGrant } from "../model/mcp/toolGrant";

export interface StoredMcpTrustGrant {
  readonly serverId: string;
  readonly configFingerprint: string;
}

export interface StoredMcpPersistentPermission extends StoredMcpTrustGrant {
  readonly chatAccess: boolean;
  readonly tools: readonly Omit<McpToolGrant, "serverId" | "configFingerprint">[];
}

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const baseGrantFields = {
  workspaceRoot: z.string().min(1),
  serverId: z.string().refine((value) => validateMcpServerId(value).ok),
  configFingerprint: fingerprintSchema,
};
const v1GrantSchema = z.object(baseGrantFields).strict();
const toolPermissionSchema = z
  .object({
    nativeToolName: z.string().min(1),
    toolSchemaFingerprint: fingerprintSchema,
  })
  .strict();
const v2GrantSchema = z
  .object({
    ...baseGrantFields,
    chatAccess: z.boolean().optional(),
    tools: z.array(toolPermissionSchema).optional(),
  })
  .strict();
const trustFileSchema = z.union([
  z.object({ version: z.literal(1), grants: z.array(v1GrantSchema) }).strict(),
  z.object({ version: z.literal(2), grants: z.array(v2GrantSchema) }).strict(),
]);

type StoredGrant = z.infer<typeof v2GrantSchema>;

export function resolveMcpTrustPath(): string {
  return path.join(resolveGlobalJellyDir(), "mcp-trust.json");
}

function normalizedWorkspaceRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot).toLocaleLowerCase();
}

function readStoredGrants(filePath = resolveMcpTrustPath()): StoredGrant[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") return [];
    throw error;
  }
  const parsed = trustFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`MCP trust store ${filePath} failed validation: ${parsed.error.message}`);
  }
  return parsed.data.grants.map((grant) => ({
    ...grant,
    chatAccess: "chatAccess" in grant ? grant.chatAccess : undefined,
    tools: "tools" in grant ? grant.tools : undefined,
  }));
}

function atomicWriteGrants(grants: readonly StoredGrant[], filePath = resolveMcpTrustPath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 2, grants }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Keep the original write error.
    }
    throw error;
  }
}

function sortGrants(grants: StoredGrant[]): StoredGrant[] {
  return grants.sort(
    (left, right) =>
      left.workspaceRoot.localeCompare(right.workspaceRoot) ||
      left.serverId.localeCompare(right.serverId),
  );
}

function updateWorkspaceGrant(
  workspaceRoot: string,
  grant: StoredMcpTrustGrant,
  update: (current: StoredGrant) => StoredGrant,
): void {
  const normalizedRoot = normalizedWorkspaceRoot(workspaceRoot);
  const grants = readStoredGrants();
  const index = grants.findIndex(
    (stored) =>
      normalizedWorkspaceRoot(stored.workspaceRoot) === normalizedRoot &&
      stored.serverId === grant.serverId,
  );
  const current =
    index >= 0 && grants[index]!.configFingerprint === grant.configFingerprint
      ? grants[index]!
      : {
          workspaceRoot: path.resolve(workspaceRoot),
          serverId: grant.serverId,
          configFingerprint: grant.configFingerprint,
        };
  const next = update(current);
  if (index >= 0) grants[index] = next;
  else grants.push(next);
  atomicWriteGrants(sortGrants(grants));
}

export function readMcpTrustGrants(workspaceRoot: string): readonly StoredMcpTrustGrant[] {
  const normalizedRoot = normalizedWorkspaceRoot(workspaceRoot);
  return readStoredGrants()
    .filter((grant) => normalizedWorkspaceRoot(grant.workspaceRoot) === normalizedRoot)
    .map(({ serverId, configFingerprint }) => ({ serverId, configFingerprint }));
}

export function readMcpPersistentPermissions(
  workspaceRoot: string,
): readonly StoredMcpPersistentPermission[] {
  const normalizedRoot = normalizedWorkspaceRoot(workspaceRoot);
  return readStoredGrants()
    .filter((grant) => normalizedWorkspaceRoot(grant.workspaceRoot) === normalizedRoot)
    .map((grant) => ({
      serverId: grant.serverId,
      configFingerprint: grant.configFingerprint,
      chatAccess: grant.chatAccess ?? false,
      tools: Object.freeze([...(grant.tools ?? [])]),
    }));
}

export function grantMcpWorkspaceTrust(workspaceRoot: string, grant: StoredMcpTrustGrant): void {
  updateWorkspaceGrant(workspaceRoot, grant, (current) => current);
}

export function grantMcpPersistentServerAccess(
  workspaceRoot: string,
  grant: StoredMcpTrustGrant,
): void {
  updateWorkspaceGrant(workspaceRoot, grant, (current) => ({ ...current, chatAccess: true }));
}

export function grantMcpPersistentToolAccesses(
  workspaceRoot: string,
  requestedGrants: readonly McpToolGrant[],
): void {
  if (requestedGrants.length === 0) return;
  const normalizedRoot = normalizedWorkspaceRoot(workspaceRoot);
  const grants = readStoredGrants();
  for (const grant of requestedGrants) {
    const index = grants.findIndex(
      (stored) =>
        normalizedWorkspaceRoot(stored.workspaceRoot) === normalizedRoot &&
        stored.serverId === grant.serverId,
    );
    const current =
      index >= 0 && grants[index]!.configFingerprint === grant.configFingerprint
        ? grants[index]!
        : {
            workspaceRoot: path.resolve(workspaceRoot),
            serverId: grant.serverId,
            configFingerprint: grant.configFingerprint,
          };
    const tools = [...(current.tools ?? [])].filter(
      (tool) => tool.nativeToolName !== grant.nativeToolName,
    );
    tools.push({
      nativeToolName: grant.nativeToolName,
      toolSchemaFingerprint: grant.toolSchemaFingerprint,
    });
    tools.sort((left, right) => left.nativeToolName.localeCompare(right.nativeToolName));
    const next = { ...current, tools };
    if (index >= 0) grants[index] = next;
    else grants.push(next);
  }
  atomicWriteGrants(sortGrants(grants));
}

export function grantMcpPersistentToolAccess(workspaceRoot: string, grant: McpToolGrant): void {
  grantMcpPersistentToolAccesses(workspaceRoot, [grant]);
}

export function revokeMcpPersistentToolAccesses(
  workspaceRoot: string,
  serverId: string,
  nativeToolNames: readonly string[],
): void {
  if (nativeToolNames.length === 0) return;
  const normalizedRoot = normalizedWorkspaceRoot(workspaceRoot);
  const grants = readStoredGrants();
  const index = grants.findIndex(
    (grant) =>
      normalizedWorkspaceRoot(grant.workspaceRoot) === normalizedRoot &&
      grant.serverId === serverId,
  );
  if (index < 0) return;
  const revoked = new Set(nativeToolNames);
  const current = grants[index]!;
  grants[index] = {
    ...current,
    tools: (current.tools ?? []).filter((tool) => !revoked.has(tool.nativeToolName)),
  };
  atomicWriteGrants(sortGrants(grants));
}

export function revokeMcpPersistentServerAccess(workspaceRoot: string, serverId: string): void {
  const normalizedRoot = normalizedWorkspaceRoot(workspaceRoot);
  const grants = readStoredGrants();
  const index = grants.findIndex(
    (grant) =>
      normalizedWorkspaceRoot(grant.workspaceRoot) === normalizedRoot &&
      grant.serverId === serverId,
  );
  if (index < 0) return;
  grants[index] = { ...grants[index]!, chatAccess: false };
  atomicWriteGrants(sortGrants(grants));
}

export function revokeMcpPersistentPermissions(
  workspaceRoot: string,
  serverId: string,
  nativeToolName?: string,
): void {
  if (nativeToolName) {
    revokeMcpPersistentToolAccesses(workspaceRoot, serverId, [nativeToolName]);
    return;
  }
  const normalizedRoot = normalizedWorkspaceRoot(workspaceRoot);
  const grants = readStoredGrants();
  const index = grants.findIndex(
    (grant) =>
      normalizedWorkspaceRoot(grant.workspaceRoot) === normalizedRoot &&
      grant.serverId === serverId,
  );
  if (index < 0) return;
  const current = grants[index]!;
  grants[index] = { ...current, chatAccess: false, tools: [] };
  atomicWriteGrants(sortGrants(grants));
}
