import type { ModelCallEndEvent } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import { modelErrorSnapshot } from "./modelErrorSnapshot";

type ModelErrorInfo = NonNullable<ModelCallEndEvent["error"]>;

describe("model error snapshot bounds", () => {
  it("bounds large messages, metadata, and cause depth without retaining arbitrary details", () => {
    const error: ModelErrorInfo = {
      name: "ModelCallError",
      message: "x".repeat(20_000),
      details: {
        code: "c".repeat(500),
        request_id: "r".repeat(500),
        request: { body: "private payload" },
      },
    };
    let tail = error;
    for (let index = 0; index < 10; index++) {
      tail.cause = { name: "Error", message: `cause ${index}` };
      tail = tail.cause;
    }
    const snapshot = modelErrorSnapshot(error);
    expect(snapshot.message).toHaveLength(2048);
    expect(snapshot.code).toHaveLength(128);
    expect(snapshot.requestId).toHaveLength(256);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.cause?.cause?.cause).toMatchObject({ message: "cause 2", truncated: true });
    expect(snapshot.cause?.cause?.cause?.cause).toBeUndefined();
    expect(JSON.stringify(snapshot).length).toBeLessThan(4096);
    expect(JSON.stringify(snapshot)).not.toContain("private payload");
  });

  it("breaks circular causes and redacts credentials before clipping a message", () => {
    const error: ModelErrorInfo = {
      name: "Error",
      message: `Failure api_key=${"secret".repeat(4000)}`,
    };
    error.cause = error;
    const snapshot = modelErrorSnapshot(error);
    expect(snapshot.message).toBe("Failure api_key=[REDACTED]");
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.cause).toBeUndefined();
    expect(error.cause).toBe(error);
  });
});
