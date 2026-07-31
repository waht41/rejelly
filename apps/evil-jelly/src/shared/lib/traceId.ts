import crypto from "node:crypto";

/** Generate an OTLP-compatible trace id: 16 random bytes encoded as 32 lowercase hex chars. */
export function generateTraceId(): string {
  return crypto.randomBytes(16).toString("hex");
}
