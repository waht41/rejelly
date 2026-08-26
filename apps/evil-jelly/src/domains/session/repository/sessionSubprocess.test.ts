import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSessionMetaLine,
  openSessionWriter,
  readSessionEvents,
  resolveV3SessionPath,
} from "../journal/sessionJsonlStore";
import { resolveLegacySessionPath } from "./legacySessionStore";
import { readV3Session } from "./sessionV3Store";

type ChildMessage =
  | { type: "writer-ready"; pid: number }
  | { type: "migration-ready"; pid: number }
  | { type: "migration-result"; kind: string }
  | { type: "error"; message: string; stack?: string };

const require = createRequire(import.meta.url);
const tsxLoaderUrl = pathToFileURL(require.resolve("tsx")).href;
const helperPath = fileURLToPath(
  new URL("./__tests__/fixtures/sessionSubprocessHelper.ts", import.meta.url),
);
// A TSX child cold-start competes with Vitest workers during the full Windows suite. The actual
// cross-process race starts only after both children report ready, so give boot/IPC a CI-sized
// budget while keeping a bounded failure for genuine hangs.
const MESSAGE_TIMEOUT_MS = 30_000;
const SUBPROCESS_TEST_TIMEOUT_MS = 45_000;

interface TrackedChild {
  process: ChildProcess;
  output: () => string;
}

function spawnHelper(
  command: "hold-writer" | "migrate",
  workspaceRoot: string,
  sessionsRoot: string,
  sessionId: string,
): TrackedChild {
  const child = spawn(
    process.execPath,
    ["--import", tsxLoaderUrl, helperPath, command, workspaceRoot, sessionsRoot, sessionId],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return {
    process: child,
    output: () => `stdout:\n${stdout}\nstderr:\n${stderr}`,
  };
}

function waitForMessage<T extends ChildMessage["type"]>(
  child: TrackedChild,
  type: T,
): Promise<Extract<ChildMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${type}\n${child.output()}`));
    }, MESSAGE_TIMEOUT_MS);
    function onMessage(message: ChildMessage) {
      if (message?.type === "error") {
        cleanup();
        reject(new Error(`${message.message}\n${message.stack ?? ""}\n${child.output()}`));
      } else if (message?.type === type) {
        cleanup();
        resolve(message as Extract<ChildMessage, { type: T }>);
      }
    }
    function onExit(code: number | null, signal: NodeJS.Signals | null) {
      cleanup();
      reject(
        new Error(
          `Child exited before ${type} (code=${code}, signal=${signal})\n${child.output()}`,
        ),
      );
    }
    function cleanup() {
      clearTimeout(timer);
      child.process.off("message", onMessage);
      child.process.off("exit", onExit);
    }
    child.process.on("message", onMessage);
    child.process.on("exit", onExit);
  });
}

function waitForExit(child: TrackedChild): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    if (child.process.exitCode !== null || child.process.signalCode !== null) {
      resolve({ code: child.process.exitCode, signal: child.process.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child exit\n${child.output()}`));
    }, MESSAGE_TIMEOUT_MS);
    function onExit(code: number | null, signal: NodeJS.Signals | null) {
      cleanup();
      resolve({ code, signal });
    }
    function cleanup() {
      clearTimeout(timer);
      child.process.off("exit", onExit);
    }
    child.process.on("exit", onExit);
  });
}

describe("session subprocess persistence", () => {
  let tmpDir: string;
  let sessionsRoot: string;
  let workspaceRoot: string;
  const children = new Set<TrackedChild>();

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-session-subprocess-"));
    sessionsRoot = path.join(tmpDir, "sessions");
    workspaceRoot = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceRoot);
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.process.exitCode === null && child.process.signalCode === null) {
        child.process.kill();
        await waitForExit(child).catch(() => undefined);
      }
    }
    children.clear();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function start(command: "hold-writer" | "migrate", sessionId: string): TrackedChild {
    const child = spawnHelper(command, workspaceRoot, sessionsRoot, sessionId);
    children.add(child);
    return child;
  }

  it(
    "reclaims a writer claim after the owning process is terminated",
    { timeout: SUBPROCESS_TEST_TIMEOUT_MS },
    async () => {
      const sessionId = "killed-writer";
      const child = start("hold-writer", sessionId);
      await waitForMessage(child, "writer-ready");

      const meta = createSessionMetaLine({
        sessionId,
        workspaceRoot,
        createdAt: 100,
        originator: "evil-jelly-subprocess-test",
        appVersion: "0.1.0",
      });
      await expect(
        openSessionWriter(meta, { sessionsRoot, traceId: "parent-trace" }),
      ).rejects.toMatchObject({
        name: "SessionWriterLockedError",
        reason: "active_writer",
        lockInfo: { traceId: "child-trace" },
      });

      expect(child.process.kill()).toBe(true);
      await waitForExit(child);

      const resumed = await openSessionWriter(meta, {
        sessionsRoot,
        traceId: "parent-trace",
      });
      await resumed.append(
        {
          type: "run_segment_started",
          kind: "resumed",
          traceId: "parent-trace",
          modelId: "test-model",
          cwd: workspaceRoot,
        },
        { timestamp: 102 },
      );
      await resumed.close();

      const stored = await readSessionEvents(workspaceRoot, sessionId, { sessionsRoot });
      expect(stored.events.map((event) => event.seq)).toEqual([1, 2]);
      expect(stored.events).toMatchObject([
        { type: "run_segment_started", traceId: "child-trace" },
        { type: "run_segment_started", traceId: "parent-trace" },
      ]);
    },
  );

  it(
    "publishes one valid V3 file when two processes migrate the same V1 session",
    { timeout: SUBPROCESS_TEST_TIMEOUT_MS },
    async () => {
      const sessionId = "migration-race";
      const legacyPath = resolveLegacySessionPath(workspaceRoot, sessionId, { sessionsRoot });
      const legacy = {
        meta: {
          id: sessionId,
          workspaceRoot,
          title: "legacy",
          createdAt: 100,
          updatedAt: 200,
          turns: 1,
          traceIds: ["legacy-trace"],
        },
        messages: [{ role: "user" as const, content: "legacy message" }],
      };
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      const legacyBytes = JSON.stringify(legacy);
      await fs.writeFile(legacyPath, legacyBytes);

      // Serialize loader startup, not migration. Both children remain behind the explicit start
      // gate, so sending both start messages below still exercises the real publish race without
      // making simultaneous TSX compilation part of what this persistence test measures.
      const first = start("migrate", sessionId);
      await waitForMessage(first, "migration-ready");
      const second = start("migrate", sessionId);
      await waitForMessage(second, "migration-ready");
      const firstResult = waitForMessage(first, "migration-result");
      const secondResult = waitForMessage(second, "migration-result");
      first.process.send?.({ type: "start" });
      second.process.send?.({ type: "start" });

      await expect(Promise.all([firstResult, secondResult])).resolves.toMatchObject([
        { kind: "found" },
        { kind: "found" },
      ]);
      await expect(Promise.all([waitForExit(first), waitForExit(second)])).resolves.toMatchObject([
        { code: 0 },
        { code: 0 },
      ]);

      await expect(fs.readFile(legacyPath, "utf8")).resolves.toBe(legacyBytes);
      await expect(
        fs.stat(resolveV3SessionPath(workspaceRoot, sessionId, { sessionsRoot })),
      ).resolves.toBeDefined();
      await expect(
        readV3Session(workspaceRoot, sessionId, { sessionsRoot }),
      ).resolves.toMatchObject({
        kind: "found",
        value: {
          meta: { id: sessionId, title: "legacy", turns: 1 },
          messages: [{ role: "user", content: "legacy message" }],
        },
      });
    },
  );
});
