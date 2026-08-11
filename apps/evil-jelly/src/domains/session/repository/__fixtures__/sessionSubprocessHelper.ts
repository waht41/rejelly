import { createSessionMetaLine, openSessionWriter } from "../../journal/sessionJsonlStore";
import { readLegacySession } from "../legacySessionStore";
import { migrateLegacySession } from "../sessionMigration";

type ParentMessage = { type: "start" };

function send(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error("Session subprocess helper requires an IPC channel"));
      return;
    }
    process.send(message, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function waitForStart(): Promise<void> {
  return new Promise((resolve, reject) => {
    function onMessage(message: ParentMessage) {
      if (message?.type === "start") {
        cleanup();
        resolve();
      }
    }
    function onDisconnect() {
      cleanup();
      reject(new Error("Parent disconnected before starting migration"));
    }
    function cleanup() {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    }
    process.on("message", onMessage);
    process.on("disconnect", onDisconnect);
  });
}

async function holdWriter(
  workspaceRoot: string,
  sessionsRoot: string,
  sessionId: string,
): Promise<never> {
  const writer = await openSessionWriter(
    createSessionMetaLine({
      sessionId,
      workspaceRoot,
      createdAt: 100,
      originator: "evil-jelly-subprocess-test",
      appVersion: "0.1.0",
    }),
    { sessionsRoot, traceId: "child-trace" },
  );
  await writer.append(
    {
      type: "run_segment_started",
      kind: "created",
      traceId: "child-trace",
      modelId: "test-model",
      cwd: workspaceRoot,
    },
    { timestamp: 101 },
  );
  await writer.flush();
  await send({ type: "writer-ready", pid: process.pid });

  // The parent intentionally terminates this process without closing the writer. This leaves the
  // claim behind and exercises real stale-PID recovery rather than a simulated lock fixture.
  return new Promise<never>(() => {
    setInterval(() => undefined, 60_000);
  });
}

async function migrate(
  workspaceRoot: string,
  sessionsRoot: string,
  sessionId: string,
): Promise<void> {
  const legacy = readLegacySession(workspaceRoot, sessionId, { sessionsRoot });
  if (legacy.kind !== "found") {
    throw new Error(`Expected a readable legacy session, got ${legacy.kind}`);
  }

  await send({ type: "migration-ready", pid: process.pid });
  await waitForStart();
  const result = await migrateLegacySession(legacy.value, {
    sessionsRoot,
    originator: "evil-jelly-subprocess-test",
    appVersion: "0.1.0",
  });
  await send({ type: "migration-result", kind: result.kind });
  if (result.kind !== "found") {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const [command, workspaceRoot, sessionsRoot, sessionId] = process.argv.slice(2);
  if (!command || !workspaceRoot || !sessionsRoot || !sessionId) {
    throw new Error(
      "Usage: sessionSubprocessHelper <hold-writer|migrate> <workspace> <sessions> <id>",
    );
  }
  if (command === "hold-writer") {
    await holdWriter(workspaceRoot, sessionsRoot, sessionId);
    return;
  }
  if (command === "migrate") {
    await migrate(workspaceRoot, sessionsRoot, sessionId);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch(async (error: unknown) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  await send({
    type: "error",
    message: normalized.message,
    stack: normalized.stack,
  }).catch(() => undefined);
  process.exitCode = 1;
});
