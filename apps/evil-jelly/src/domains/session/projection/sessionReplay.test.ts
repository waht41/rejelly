import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../model/sessionEvents";
import { prepareSessionReplay } from "./sessionReplay";

describe("prepareSessionReplay", () => {
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
