/** User-level MCP workspace trust grants. Stores fingerprints only, never executable config. */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getErrnoCode } from "../foundation/errno";
import { resolveGlobalJellyDir } from "../globalPath";
import { validateMcpServerId } from "../model/mcp/serverIdentity";

export interface StoredMcpTrustGrant {
  readonly serverId: string;
  readonly configFingerprint: string;
}

const trustGrantSchema = z
  .object({
    workspaceRoot: z.string().min(1),
    serverId: z.string().refine((value) => validateMcpServerId(value).ok),
    configFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const trustFileSchema = z
  .object({
    version: z.literal(1),
    grants: z.array(trustGrantSchema),
  })
  .strict();

type StoredTrustGrant = z.infer<typeof trustGrantSchema>;

export function resolveMcpTrustPath(): string {
  return path.join(resolveGlobalJellyDir(), "mcp-trust.json");
}

function normalizedWorkspaceRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot).toLocaleLowerCase();
}

function readStoredGrants(filePath = resolveMcpTrustPath()): StoredTrustGrant[] {
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
  return parsed.data.grants;
}

function atomicWriteGrants(
  grants: readonly StoredTrustGrant[],
  filePath = resolveMcpTrustPath(),
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, grants }, null, 2)}\n`, {
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

export function readMcpTrustGrants(workspaceRoot: string): readonly StoredMcpTrustGrant[] {
  const normalizedRoot = normalizedWorkspaceRoot(workspaceRoot);
  return readStoredGrants()
    .filter((grant) => normalizedWorkspaceRoot(grant.workspaceRoot) === normalizedRoot)
    .map(({ serverId, configFingerprint }) => ({ serverId, configFingerprint }));
}

export function grantMcpWorkspaceTrust(workspaceRoot: string, grant: StoredMcpTrustGrant): void {
  const normalizedRoot = normalizedWorkspaceRoot(workspaceRoot);
  const retained = readStoredGrants().filter(
    (stored) =>
      !(
        normalizedWorkspaceRoot(stored.workspaceRoot) === normalizedRoot &&
        stored.serverId === grant.serverId
      ),
  );
  retained.push({ workspaceRoot: path.resolve(workspaceRoot), ...grant });
  retained.sort(
    (left, right) =>
      left.workspaceRoot.localeCompare(right.workspaceRoot) ||
      left.serverId.localeCompare(right.serverId),
  );
  atomicWriteGrants(retained);
}
