import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../model/sessionEvents";
import { prepareSessionReplay } from "./sessionReplay";

describe("prepareSessionReplay", () => {
  it("upgrades pre-ordinal resolved images in session order without rewriting storage", () => {
    const blob = {
      blobRef: `rejelly-blob://${"a".repeat(64)}`,
      sha256: "a".repeat(64),
      mediaType: "image/png" as const,
      byteLength: 1,
    };
    const events = [1, 2].map(
      (seq): SessionEvent => ({
        type: "user_input_recorded",
        seq,
        timestamp: seq,
        turnId: `turn-${seq}`,
        inputKind: "initial",
        input: {
          version: 1,
          kind: "resolved",
          nodes: [{ kind: "image", blob, detail: "auto" }],
        },
      }),
    );

    const replay = prepareSessionReplay(events);

    expect(
      replay.events.flatMap((event) =>
        event.type === "user_input_recorded" && event.input.kind === "resolved"
          ? event.input.nodes.flatMap((node) => (node.kind === "image" ? [node.imageOrdinal] : []))
          : [],
      ),
    ).toEqual([1, 2]);
    expect(events[0]).not.toHaveProperty("input.nodes.0.imageOrdinal");
  });

  it("normalizes stored messages once and filters unknown events without losing tail coordinates", () => {
    const events: SessionEvent[] = [
      {
        type: "message_recorded",
        seq: 3,
        timestamp: 103,
        turnId: "turn-1",
        source: { kind: "user_input", inputKind: "initial" },
        message: { role: "user", content: "hello" },
      },
      { type: "future_event", seq: 4, timestamp: 104, payload: "preserved in the log" },
    ];

    const replay = prepareSessionReplay(events);

    expect(replay.events).toEqual([
      expect.objectContaining({
        type: "message_recorded",
        message: { role: "user", content: "hello" },
      }),
    ]);
    expect(replay).toMatchObject({ lastSeq: 4, lastTimestamp: 104 });
    expect(Object.isFrozen(replay.events)).toBe(true);
  });

  it("rejects unordered events and invalid stored image forms at the shared boundary", () => {
    expect(() =>
      prepareSessionReplay([
        { type: "future", seq: 2, timestamp: 2 },
        { type: "future", seq: 2, timestamp: 3 },
      ]),
    ).toThrow("strictly increasing");

    expect(() =>
      prepareSessionReplay([
        {
          type: "message_recorded",
          seq: 1,
          timestamp: 1,
          turnId: "turn-1",
          source: { kind: "user_input", inputKind: "initial" },
          message: {
            role: "user",
            content: [{ type: "image", image: { url: "data:image/png;base64,aW1hZ2U=" } }],
          },
        },
      ]),
    ).toThrow("cannot contain inline image");
  });
});
