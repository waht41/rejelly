import { describe, expect, it } from "vitest";
import {
  isKnownSessionEvent,
  parseNewSessionEvent,
  parseSessionEvent,
  parseSessionMetaLine,
  SESSION_SCHEMA_VERSION,
  SessionSchemaError,
} from "./sessionEvents";

describe("sessionEvents", () => {
  it("validates the immutable V2 metadata header", () => {
    expect(
      parseSessionMetaLine({
        type: "session_meta",
        schemaVersion: SESSION_SCHEMA_VERSION,
        sessionId: "session-1",
        workspaceRoot: "/work",
        createdAt: 1,
        originator: "evil-jelly",
        appVersion: "0.1.0",
      }),
    ).toMatchObject({ sessionId: "session-1", schemaVersion: 2 });
  });

  it("rejects unsupported schema versions", () => {
    expect(() =>
      parseSessionMetaLine({
        type: "session_meta",
        schemaVersion: 3,
        sessionId: "session-1",
        workspaceRoot: "/work",
        createdAt: 1,
        originator: "evil-jelly",
        appVersion: "0.1.0",
      }),
    ).toThrow(SessionSchemaError);
  });

  it("preserves forward-compatible unknown event envelopes", () => {
    const event = parseSessionEvent({
      type: "future_event",
      seq: 1,
      timestamp: 2,
      futurePayload: { enabled: true },
    });
    expect(isKnownSessionEvent(event)).toBe(false);
    expect(event).toMatchObject({ type: "future_event", futurePayload: { enabled: true } });
  });

  it("validates known event payloads instead of treating malformed ones as unknown", () => {
    expect(() =>
      parseSessionEvent({
        type: "message_recorded",
        seq: 1,
        timestamp: 2,
        turnId: "turn-1",
        source: { kind: "user_input", inputKind: "initial" },
      }),
    ).toThrow(SessionSchemaError);
  });

  it("requires user input to distinguish an initial request from a steer", () => {
    expect(
      parseSessionEvent({
        type: "message_recorded",
        seq: 1,
        timestamp: 2,
        turnId: "turn-1",
        source: { kind: "user_input", inputKind: "steer" },
        message: { role: "user", content: "Please also check the tests." },
      }),
    ).toMatchObject({
      source: { kind: "user_input", inputKind: "steer" },
    });

    expect(() =>
      parseSessionEvent({
        type: "message_recorded",
        seq: 1,
        timestamp: 2,
        turnId: "turn-1",
        source: { kind: "user_input" },
        message: { role: "user", content: "Ambiguous user input" },
      }),
    ).toThrow(SessionSchemaError);
  });

  it("uses created/resumed for run starts instead of encoding the caller path", () => {
    expect(
      parseSessionEvent({
        type: "run_segment_started",
        seq: 1,
        timestamp: 2,
        traceId: "trace-1",
        kind: "resumed",
        modelId: "model",
        cwd: "/work",
      }),
    ).toMatchObject({ kind: "resumed", traceId: "trace-1" });

    expect(() =>
      parseSessionEvent({
        type: "run_segment_started",
        seq: 1,
        timestamp: 2,
        traceId: "trace-1",
        reason: "startup_resume",
        modelId: "model",
        cwd: "/work",
      }),
    ).toThrow(SessionSchemaError);
  });

  it("accepts agent-runtime messages and rejects nonexistent archived state", () => {
    expect(
      parseSessionEvent({
        type: "message_recorded",
        seq: 1,
        timestamp: 2,
        turnId: "turn-1",
        source: { kind: "agent_runtime" },
        message: { role: "user", content: "Validation failed; retry." },
      }),
    ).toMatchObject({ source: { kind: "agent_runtime" } });

    expect(() =>
      parseSessionEvent({
        type: "session_state",
        seq: 2,
        timestamp: 3,
        coveredThroughSeq: 1,
        userTurns: 1,
        title: "Session",
        traceIds: ["trace-1"],
        status: "archived",
      }),
    ).toThrow(SessionSchemaError);
  });

  it("only associates automatic compaction with a running parent turn", () => {
    const compact = {
      type: "context_compacted" as const,
      trigger: "auto" as const,
      activeTurnId: "turn-1",
      replacementHistory: [],
      beforeMessageCount: 3,
      afterMessageCount: 1,
    };

    expect(parseNewSessionEvent(compact)).toMatchObject({
      trigger: "auto",
      activeTurnId: "turn-1",
    });
    expect(
      parseSessionEvent({
        ...compact,
        seq: 1,
        timestamp: 2,
      }),
    ).toMatchObject({ trigger: "auto", activeTurnId: "turn-1" });

    expect(() =>
      parseNewSessionEvent({
        ...compact,
        trigger: "manual",
      }),
    ).toThrow(SessionSchemaError);
    expect(() =>
      parseSessionEvent({
        ...compact,
        trigger: "manual",
        seq: 1,
        timestamp: 2,
      }),
    ).toThrow(SessionSchemaError);
  });
});
