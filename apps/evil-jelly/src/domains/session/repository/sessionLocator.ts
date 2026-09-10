import fs from "node:fs";
import path from "node:path";
import { getErrnoCode } from "../../../shared/foundation/errno";
import {
  MAX_META_LINE_BYTES,
  resolveV2SessionPath,
  resolveV3SessionPath,
} from "../journal/sessionJsonlReader";
import { assertSessionId, resolveSessionsRoot, workspaceBucket } from "../journal/sessionPaths";

type InspectableJournalVersion = 2 | 3;

export interface InspectSessionLocation {
  sessionId: string;
  workspaceRoot: string;
  journalVersion: InspectableJournalVersion;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

export async function locateInspectSession(
  workspaceRoot: string,
  sessionId: string,
  sessionsRoot = resolveSessionsRoot(),
): Promise<InspectSessionLocation> {
  assertSessionId(sessionId);
  const paths = { sessionsRoot };
  if (await pathExists(resolveV3SessionPath(workspaceRoot, sessionId, paths))) {
    return { workspaceRoot, sessionId, journalVersion: 3 };
  }
  if (await pathExists(resolveV2SessionPath(workspaceRoot, sessionId, paths))) {
    return { workspaceRoot, sessionId, journalVersion: 2 };
  }
  throw new Error(
    `Session ${sessionId} was not found in workspace ${workspaceRoot}. ` +
      `Try: evil inspect ${sessionId} --all-workspaces`,
  );
}

interface JournalIdentity {
  sessionId: string;
  workspaceRoot: string;
  schemaVersion: InspectableJournalVersion;
}

async function readJournalIdentity(
  filePath: string,
  expectedSessionId: string,
  expectedVersion: InspectableJournalVersion,
): Promise<JournalIdentity> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(MAX_META_LINE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0 || newline > MAX_META_LINE_BYTES) {
      throw new Error(`Invalid or oversized session_meta in ${filePath}`);
    }
    const line = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
    const value = JSON.parse(line) as Record<string, unknown>;
    if (
      value.type !== "session_meta" ||
      value.sessionId !== expectedSessionId ||
      value.schemaVersion !== expectedVersion ||
      typeof value.workspaceRoot !== "string"
    ) {
      throw new Error(`Session identity does not match its journal path: ${filePath}`);
    }
    return {
      sessionId: expectedSessionId,
      workspaceRoot: value.workspaceRoot,
      schemaVersion: expectedVersion,
    };
  } finally {
    await handle.close();
  }
}

async function findJournalInBucket(
  sessionsRoot: string,
  bucketName: string,
  sessionId: string,
): Promise<InspectSessionLocation | undefined> {
  const candidates: ReadonlyArray<{ fileName: string; version: InspectableJournalVersion }> = [
    { fileName: `${sessionId}.v3.jsonl`, version: 3 },
    { fileName: `${sessionId}.jsonl`, version: 2 },
  ];
  for (const candidate of candidates) {
    const filePath = path.join(sessionsRoot, bucketName, candidate.fileName);
    if (!(await pathExists(filePath))) continue;
    const identity = await readJournalIdentity(filePath, sessionId, candidate.version);
    if (workspaceBucket(identity.workspaceRoot) !== bucketName) {
      throw new Error(`Session workspace does not match its storage bucket: ${filePath}`);
    }
    return {
      sessionId,
      workspaceRoot: identity.workspaceRoot,
      journalVersion: identity.schemaVersion,
    };
  }
  return undefined;
}

export async function findInspectSessionAcrossWorkspaces(
  sessionId: string,
  sessionsRoot = resolveSessionsRoot(),
): Promise<InspectSessionLocation> {
  assertSessionId(sessionId);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") {
      throw new Error(`No Evil Jelly Session store found at ${sessionsRoot}`);
    }
    throw error;
  }

  const matches: InspectSessionLocation[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = await findJournalInBucket(sessionsRoot, entry.name, sessionId);
    if (match) matches.push(match);
  }

  if (matches.length === 0) {
    throw new Error(`Session ${sessionId} was not found in any Evil Jelly workspace.`);
  }
  if (matches.length > 1) {
    const workspaces = matches
      .map((match) => match.workspaceRoot)
      .sort()
      .map((workspaceRoot) => `  - ${workspaceRoot}`)
      .join("\n");
    throw new Error(
      `Session id ${sessionId} exists in multiple workspaces. ` +
        `Use --workspace <dir> to select one:\n${workspaces}`,
    );
  }
  return matches[0];
}
