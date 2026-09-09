import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceBucket } from "../journal/sessionPaths";
import { findInspectSessionAcrossWorkspaces, locateInspectSession } from "./sessionLocator";

const cleanup: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "evil-inspect-selection-"));
  cleanup.push(dir);
  return dir;
}

async function writeJournal(
  sessionsRoot: string,
  workspaceRoot: string,
  sessionId: string,
  version: 2 | 3,
): Promise<void> {
  const bucket = path.join(sessionsRoot, workspaceBucket(workspaceRoot));
  await fs.promises.mkdir(bucket, { recursive: true });
  const fileName = version === 3 ? `${sessionId}.v3.jsonl` : `${sessionId}.jsonl`;
  await fs.promises.writeFile(
    path.join(bucket, fileName),
    `${JSON.stringify({
      type: "session_meta",
      schemaVersion: version,
      sessionId,
      workspaceRoot: path.resolve(workspaceRoot),
      createdAt: 1,
      originator: "test",
      appVersion: "0.0.0",
    })}\n`,
  );
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true })));
});

describe("inspect Session selection", () => {
  it("prefers V3 and falls back to V2 in an explicit workspace", async () => {
    const root = await tempDir();
    const sessionsRoot = path.join(root, "sessions");
    const workspaceRoot = path.join(root, "workspace");
    await writeJournal(sessionsRoot, workspaceRoot, "v2-only", 2);

    await expect(
      locateInspectSession(workspaceRoot, "v2-only", sessionsRoot),
    ).resolves.toMatchObject({
      sessionId: "v2-only",
      journalVersion: 2,
    });
    await writeJournal(sessionsRoot, workspaceRoot, "v2-only", 3);
    await expect(
      locateInspectSession(workspaceRoot, "v2-only", sessionsRoot),
    ).resolves.toMatchObject({
      journalVersion: 3,
    });
  });

  it("finds an exact Session id across workspace buckets", async () => {
    const root = await tempDir();
    const sessionsRoot = path.join(root, "sessions");
    const workspaceRoot = path.join(root, "other-workspace");
    await writeJournal(sessionsRoot, workspaceRoot, "target", 3);
    await fs.promises.mkdir(path.join(sessionsRoot, "unrelated-bucket"));

    await expect(findInspectSessionAcrossWorkspaces("target", sessionsRoot)).resolves.toEqual({
      sessionId: "target",
      workspaceRoot: path.resolve(workspaceRoot),
      journalVersion: 3,
    });
  });

  it("requires workspace disambiguation when an id appears more than once", async () => {
    const root = await tempDir();
    const sessionsRoot = path.join(root, "sessions");
    await writeJournal(sessionsRoot, path.join(root, "workspace-a"), "duplicate", 3);
    await writeJournal(sessionsRoot, path.join(root, "workspace-b"), "duplicate", 3);

    await expect(findInspectSessionAcrossWorkspaces("duplicate", sessionsRoot)).rejects.toThrow(
      "exists in multiple workspaces",
    );
  });
});
