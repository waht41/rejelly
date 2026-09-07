import { describe, expect, it } from "vitest";
import type { TraceEvent } from "../domain/events";
import { createEmitter } from "./telemetry";

describe("telemetry provider state projection", () => {
  it("emits namespace metadata and byte size without opaque payload", () => {
    const events: TraceEvent[] = [];
    const emitter = createEmitter((event) => events.push(event), {
      traceId: "trace-1",
      spanId: "span-1",
      parentSpanId: "root",
    });
    const message = {
      role: "assistant" as const,
      content: "answer",
      provider_state: [
        {
          kind: "@test/fictional/items",
          version: 2,
          payload: { encrypted: "secret-payload" },
        },
      ],
    };

    emitter.turnEnd({
      step: 0,
      messages: [message],
      messageCount: 1,
      resultType: "content",
      message,
      duration: 1,
      success: true,
      cache: false,
    });

    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain("secret-payload");
    expect(events[0]).toMatchObject({
      messages: [
        {
          provider_state: [
            {
              kind: "@test/fictional/items",
              version: 2,
              payloadBytes: new TextEncoder().encode(
                JSON.stringify(message.provider_state[0].payload),
              ).byteLength,
            },
          ],
        },
      ],
      message: {
        provider_state: [
          {
            kind: "@test/fictional/items",
            version: 2,
          },
        ],
      },
    });
  });
});
