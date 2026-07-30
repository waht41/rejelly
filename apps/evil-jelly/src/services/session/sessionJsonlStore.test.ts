import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionMetaLine,
  findLatestSessionStateFromTail,
  openSessionWriter,
  readEventAtOffset,
  readSessionEvents,
  readSessionMetaLine,
  resolveV2SessionPath,
  SessionCorruptionError,
} from "./sessionJsonlStore";

describe("sessionJsonlStore", () => {
  let tmpDir: string;
  let sessionsRoot: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-session-v2-"));
    sessionsRoot = path.join(tmpDir, "sessions");
    workspaceRoot = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceRoot);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function meta(sessionId = "session-1") {
    return createSessionMetaLine({
      sessionId,
      workspaceRoot,
      createdAt: 100,
      originator: "evil-jelly",
      appVersion: "0.1.0",
    });
  }

  function lockDirectory(filePath: string): string {
    return path.join(path.dirname(filePath), ".locks", path.basename(filePath));
  }

  it("appends ordered events without rewriting the existing prefix", async () => {
    const writer = await openSessionWriter(meta(), { sessionsRoot });
    const prefix = await fs.readFile(writer.filePath);
    await writer.append(
      {
        type: "message_recorded",
        turnId: "turn-1",
        source: "user_input",
        message: { role: "user", content: "你好\nworld" },
      },
      { timestamp: 101 },
    );
    const afterFirst = await fs.readFile(writer.filePath);
    expect(afterFirst.subarray(0, prefix.length)).toEqual(prefix);

    await writer.append(
      {
        type: "turn_completed",
        turnId: "turn-1",
        status: "completed",
      },
      { timestamp: 102 },
    );
    await writer.close();

    const result = await readSessionEvents(workspaceRoot, "session-1", { sessionsRoot });
    expect(result.warnings).toEqual([]);
    expect(result.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(result.events[0]).toMatchObject({
      type: "message_recorded",
      message: { content: "你好\nworld" },
    });
    await expect(
      readSessionMetaLine(workspaceRoot, "session-1", { sessionsRoot }),
    ).resolves.toMatchObject({ sessionId: "session-1", createdAt: 100 });
  });

  it("rejects a second active writer for the same session", async () => {
    const writer = await openSessionWriter(meta(), { sessionsRoot, traceId: "trace-a" });
    await expect(
      openSessionWriter(meta(), { sessionsRoot, traceId: "trace-b" }),
    ).rejects.toMatchObject({
      name: "SessionWriterLockedError",
      reason: "active_writer",
      lockInfo: { traceId: "trace-a" },
    });
    await writer.close();
  });

  it("never grants two simultaneous writer claims", async () => {
    const attempts = await Promise.allSettled([
      openSessionWriter(meta(), { sessionsRoot, traceId: "trace-a" }),
      openSessionWriter(meta(), { sessionsRoot, traceId: "trace-b" }),
    ]);
    const writers = attempts.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(writers.length).toBeLessThanOrEqual(1);
    expect(attempts.some((result) => result.status === "rejected")).toBe(true);
    await Promise.all(writers.map((writer) => writer.close()));
  });

  it("serializes concurrent appends and assigns distinct offsets and seq values", async () => {
    const writer = await openSessionWriter(meta(), { sessionsRoot });
    const [first, second] = await Promise.all([
      writer.append({
        type: "message_recorded",
        turnId: "turn-1",
        source: "user_input",
        message: { role: "user", content: "hello" },
      }),
      writer.append({
        type: "turn_completed",
        turnId: "turn-1",
        status: "completed",
      }),
    ]);
    await writer.close();

    expect([first.event.seq, second.event.seq]).toEqual([1, 2]);
    expect(second.offset).toBe(first.offset + first.byteLength);
    const result = await readSessionEvents(workspaceRoot, "session-1", { sessionsRoot });
    expect(result.events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("waits for an already queued append before closing", async () => {
    const blobRoot = path.join(tmpDir, "blobs");
    const writer = await openSessionWriter(meta(), { sessionsRoot, blobRoot });
    const append = writer.append({
      type: "message_recorded",
      turnId: "turn-1",
      source: "user_input",
      message: {
        role: "user",
        content: [
          {
            type: "image",
            image: { url: `data:image/png;base64,${Buffer.from("queued").toString("base64")}` },
          },
        ],
      },
    });
    const close = writer.close();
    await Promise.all([append, close]);

    const result = await readSessionEvents(workspaceRoot, "session-1", { sessionsRoot });
    expect(result.events).toHaveLength(1);
  });

  it("reclaims a unique lock claim whose owner process no longer exists", async () => {
    const filePath = resolveV2SessionPath(workspaceRoot, "session-1", { sessionsRoot });
    const claimsDirectory = lockDirectory(filePath);
    await fs.mkdir(claimsDirectory, { recursive: true });
    const token = "stale-token";
    const claimPath = path.join(claimsDirectory, `${token}.json`);
    await fs.writeFile(
      claimPath,
      `${JSON.stringify({
        pid: 2_147_483_647,
        hostname: os.hostname(),
        startedAt: 1,
        token,
      })}\n`,
    );
    const writer = await openSessionWriter(meta(), { sessionsRoot });
    await writer.close();
    await expect(fs.stat(claimPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(claimsDirectory)).toEqual([]);
  });

  it("does not apply local PID stale checks to a foreign-host claim", async () => {
    const filePath = resolveV2SessionPath(workspaceRoot, "session-1", { sessionsRoot });
    const claimsDirectory = lockDirectory(filePath);
    await fs.mkdir(claimsDirectory, { recursive: true });
    const token = "foreign-token";
    await fs.writeFile(
      path.join(claimsDirectory, `${token}.json`),
      `${JSON.stringify({
        pid: 2_147_483_647,
        hostname: "another-host",
        startedAt: 1,
        token,
      })}\n`,
    );

    await expect(openSessionWriter(meta(), { sessionsRoot })).rejects.toMatchObject({
      name: "SessionWriterLockedError",
      reason: "foreign_host",
    });
  });

  it("publishes a complete claim atomically inside the isolated lock directory", async () => {
    const writer = await openSessionWriter(meta(), { sessionsRoot, traceId: "trace-a" });
    const claimsDirectory = lockDirectory(writer.filePath);
    const entries = await fs.readdir(claimsDirectory);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^[a-f0-9]{32}\.json$/);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
    await expect(
      fs.readFile(path.join(claimsDirectory, entries[0] ?? ""), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      pid: process.pid,
      hostname: os.hostname(),
      traceId: "trace-a",
    });
    await writer.close();
  });

  it("never scans or removes session data whose name resembles the old claim prefix", async () => {
    const filePath = resolveV2SessionPath(workspaceRoot, "session-1", { sessionsRoot });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const unrelatedSession = `${filePath}.lock.crafted.jsonl`;
    const contents = "unrelated durable session data\n";
    await fs.writeFile(unrelatedSession, contents);

    const writer = await openSessionWriter(meta(), { sessionsRoot });
    await writer.close();
    await expect(fs.readFile(unrelatedSession, "utf8")).resolves.toBe(contents);
  });

  it("keeps an invalid claim and fails closed", async () => {
    const filePath = resolveV2SessionPath(workspaceRoot, "session-1", { sessionsRoot });
    const claimsDirectory = lockDirectory(filePath);
    await fs.mkdir(claimsDirectory, { recursive: true });
    const claimPath = path.join(claimsDirectory, "invalid-token.json");
    await fs.writeFile(claimPath, "{not-json");

    await expect(openSessionWriter(meta(), { sessionsRoot })).rejects.toMatchObject({
      name: "SessionWriterLockedError",
      reason: "invalid_claim",
      claimPath,
    });
    await expect(fs.readFile(claimPath, "utf8")).resolves.toBe("{not-json");
  });

  it("keeps a claim whose filename and embedded token disagree", async () => {
    const filePath = resolveV2SessionPath(workspaceRoot, "session-1", { sessionsRoot });
    const claimsDirectory = lockDirectory(filePath);
    await fs.mkdir(claimsDirectory, { recursive: true });
    const claimPath = path.join(claimsDirectory, "filename-token.json");
    await fs.writeFile(
      claimPath,
      `${JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        startedAt: 1,
        token: "different-token",
      })}\n`,
    );

    await expect(openSessionWriter(meta(), { sessionsRoot })).rejects.toMatchObject({
      name: "SessionWriterLockedError",
      reason: "invalid_claim",
      claimPath,
    });
    await expect(fs.stat(claimPath)).resolves.toMatchObject({});
  });

  it("keeps an unreadable claim and fails closed", async () => {
    const filePath = resolveV2SessionPath(workspaceRoot, "session-1", { sessionsRoot });
    const claimsDirectory = lockDirectory(filePath);
    await fs.mkdir(claimsDirectory, { recursive: true });
    const claimPath = path.join(claimsDirectory, "unreadable-token.json");
    await fs.mkdir(claimPath);

    await expect(openSessionWriter(meta(), { sessionsRoot })).rejects.toMatchObject({
      name: "SessionWriterLockedError",
      reason: "unreadable_claim",
      claimPath,
    });
    await expect(fs.stat(claimPath)).resolves.toMatchObject({});
  });

  it.each(["empty", "partial"] as const)("repairs %s metadata creation residue", async (kind) => {
    const expectedMeta = meta();
    const filePath = resolveV2SessionPath(workspaceRoot, "session-1", { sessionsRoot });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, kind === "empty" ? "" : '{"type":"session_meta","schema');

    const writer = await openSessionWriter(expectedMeta, { sessionsRoot });
    expect(writer.nextSeq).toBe(1);
    await writer.close();
    await expect(
      readSessionMetaLine(workspaceRoot, "session-1", { sessionsRoot }),
    ).resolves.toEqual(expectedMeta);
  });

  it("rejects an invalid event before writing its image blob", async () => {
    const blobRoot = path.join(tmpDir, "invalid-event-blobs");
    const writer = await openSessionWriter(meta(), { sessionsRoot, blobRoot });
    await expect(
      writer.append({
        type: "message_recorded",
        turnId: "turn-1",
        source: "not-a-source",
        message: {
          role: "user",
          content: [
            {
              type: "image",
              image: { url: `data:image/png;base64,${Buffer.from("orphan").toString("base64")}` },
            },
          ],
        },
      } as never),
    ).rejects.toThrow("Invalid new Session V2 event");
    await writer.append({
      type: "turn_completed",
      turnId: "turn-1",
      status: "interrupted",
    });
    await writer.close();
    await expect(fs.stat(blobRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const result = await readSessionEvents(workspaceRoot, "session-1", { sessionsRoot });
    expect(result.events).toHaveLength(1);
  });

  it("ignores a partial tail and truncates it before the next append", async () => {
    const writer = await openSessionWriter(meta(), { sessionsRoot });
    await writer.append({
      type: "message_recorded",
      turnId: "turn-1",
      source: "user_input",
      message: { role: "user", content: "persisted" },
    });
    await writer.close();
    const goodSize = (await fs.stat(writer.filePath)).size;
    await fs.appendFile(writer.filePath, '{"type":"message_recorded","seq":2');

    const damaged = await readSessionEvents(workspaceRoot, "session-1", { sessionsRoot });
    expect(damaged.events).toHaveLength(1);
    expect(damaged.warnings).toEqual([
      {
        kind: "trailing_partial_line",
        offset: goodSize,
        byteLength: expect.any(Number),
      },
    ]);

    const resumed = await openSessionWriter(meta(), { sessionsRoot });
    expect(resumed.nextSeq).toBe(2);
    await resumed.append({
      type: "turn_completed",
      turnId: "turn-1",
      status: "interrupted",
      recovered: true,
    });
    await resumed.close();
    const recovered = await readSessionEvents(workspaceRoot, "session-1", { sessionsRoot });
    expect(recovered.warnings).toEqual([]);
    expect(recovered.events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("reopens an existing writer without FileHandle.readFile full replay", async () => {
    const writer = await openSessionWriter(meta(), { sessionsRoot });
    await writer.append({
      type: "message_recorded",
      turnId: "turn-1",
      source: "user_input",
      message: { role: "user", content: "persisted" },
    });
    await writer.close();

    const probe = await fs.open(writer.filePath, "r");
    const readFileSpy = vi.spyOn(Object.getPrototypeOf(probe), "readFile");
    await probe.close();
    try {
      const resumed = await openSessionWriter(meta(), { sessionsRoot });
      expect(resumed.nextSeq).toBe(2);
      expect(readFileSpy).not.toHaveBeenCalled();
      await resumed.close();
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("reports corruption in a complete middle line", async () => {
    const filePath = resolveV2SessionPath(workspaceRoot, "session-1", { sessionsRoot });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      `${JSON.stringify(meta())}\n{"type":"broken"\n${JSON.stringify({
        type: "future_event",
        seq: 1,
        timestamp: 1,
      })}\n`,
    );
    await expect(
      readSessionEvents(workspaceRoot, "session-1", { sessionsRoot }),
    ).rejects.toBeInstanceOf(SessionCorruptionError);
  });

  it("preserves unknown events while enforcing contiguous seq", async () => {
    const filePath = resolveV2SessionPath(workspaceRoot, "session-1", { sessionsRoot });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      `${JSON.stringify(meta())}\n${JSON.stringify({
        type: "future_event",
        seq: 1,
        timestamp: 101,
        payload: "kept",
      })}\n`,
    );
    const result = await readSessionEvents(workspaceRoot, "session-1", { sessionsRoot });
    expect(result.events[0]).toMatchObject({ type: "future_event", payload: "kept" });

    await fs.appendFile(
      filePath,
      `${JSON.stringify({ type: "future_event", seq: 3, timestamp: 102 })}\n`,
    );
    await expect(readSessionEvents(workspaceRoot, "session-1", { sessionsRoot })).rejects.toThrow(
      "Non-contiguous event seq",
    );
  });

  it("locates and validates the latest state checkpoint from the tail", async () => {
    const writer = await openSessionWriter(meta(), { sessionsRoot });
    const compact = await writer.append({
      type: "context_compacted",
      trigger: "auto",
      replacementHistory: [{ role: "user", content: "summary bridge" }],
      beforeMessageCount: 10,
      afterMessageCount: 1,
    });
    const state = await writer.append({
      type: "session_state",
      coveredThroughSeq: compact.event.seq,
      userTurns: 4,
      title: "session title",
      lastCompactSeq: compact.event.seq,
      lastCompactOffset: compact.offset,
      traceIds: ["trace-1"],
      status: "idle",
    });
    await writer.close();

    await expect(
      readEventAtOffset(workspaceRoot, "session-1", compact.offset, { sessionsRoot }),
    ).resolves.toMatchObject({
      event: { type: "context_compacted", seq: 1 },
      offset: compact.offset,
    });
    await expect(
      readEventAtOffset(workspaceRoot, "session-1", compact.offset + 1, { sessionsRoot }),
    ).rejects.toThrow("line boundary");
    await expect(
      findLatestSessionStateFromTail(workspaceRoot, "session-1", { sessionsRoot }),
    ).resolves.toMatchObject({
      event: { type: "session_state", seq: 2, coveredThroughSeq: 1 },
      offset: state.offset,
    });
  });

  it("persists inline image bytes before appending the user event", async () => {
    const blobRoot = path.join(tmpDir, "blobs");
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(20, 16);
    bytes.writeUInt32BE(10, 20);
    const inlineUrl = `data:image/png;base64,${bytes.toString("base64")}`;
    const writer = await openSessionWriter(meta(), { sessionsRoot, blobRoot });
    await writer.append({
      type: "message_recorded",
      turnId: "turn-1",
      source: "user_input",
      message: {
        role: "user",
        content: [{ type: "image", image: { url: inlineUrl } }],
        extra: { rejelly: { kind: "user_input" } },
      },
    });
    await writer.close();

    const raw = await fs.readFile(writer.filePath, "utf8");
    expect(raw).not.toContain(inlineUrl);
    expect(raw).toContain("rejelly-blob://");
    expect(await fs.readdir(blobRoot)).toHaveLength(1);
  });

  it("falls back when a tail checkpoint contains a stale compact offset", async () => {
    const writer = await openSessionWriter(meta(), { sessionsRoot });
    await writer.append({
      type: "message_recorded",
      turnId: "turn-1",
      source: "user_input",
      message: { role: "user", content: "hello" },
    });
    await writer.append({
      type: "session_state",
      coveredThroughSeq: 1,
      userTurns: 1,
      title: "hello",
      lastCompactSeq: 1,
      lastCompactOffset: 0,
      traceIds: [],
      status: "idle",
    });
    await writer.close();
    await expect(
      findLatestSessionStateFromTail(workspaceRoot, "session-1", { sessionsRoot }),
    ).resolves.toBeUndefined();
  });

  it("does not loop when a malformed tail starts with a newline", async () => {
    const filePath = resolveV2SessionPath(workspaceRoot, "session-1", { sessionsRoot });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "\n");
    await expect(
      findLatestSessionStateFromTail(workspaceRoot, "session-1", { sessionsRoot }),
    ).resolves.toBeUndefined();
  });

  it("reads an event line larger than the initial bounded-read window", async () => {
    const writer = await openSessionWriter(meta(), { sessionsRoot });
    const appended = await writer.append({
      type: "message_recorded",
      turnId: "turn-1",
      source: "user_input",
      message: { role: "user", content: "x".repeat(96 * 1024) },
    });
    await writer.close();

    await expect(
      readEventAtOffset(workspaceRoot, "session-1", appended.offset, { sessionsRoot }),
    ).resolves.toMatchObject({
      event: { type: "message_recorded", seq: 1 },
      byteLength: appended.byteLength,
    });
  });

  it("rejects unsafe session identifiers", () => {
    expect(() => resolveV2SessionPath(workspaceRoot, "../escape", { sessionsRoot })).toThrow(
      "Unsafe session id",
    );
    expect(() => resolveV2SessionPath(workspaceRoot, "safe-id", { sessionsRoot })).not.toThrow();
  });
});
