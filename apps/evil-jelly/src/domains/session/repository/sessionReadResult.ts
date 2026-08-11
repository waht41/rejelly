import { getErrnoCode } from "../../../shared/foundation/errno";

export type SessionReadFailureKind = "missing" | "corrupt" | "unreadable";

export type SessionReadResult<T> =
  | { kind: "found"; value: T }
  | { kind: SessionReadFailureKind; error?: unknown };

export class SessionStoreReadError extends Error {
  constructor(
    readonly kind: Exclude<SessionReadFailureKind, "missing">,
    readonly format: "v1" | "v2" | "store",
    readonly sessionId: string,
    readonly cause: unknown,
  ) {
    super(`Session ${sessionId} ${format.toUpperCase()} is ${kind}`, { cause });
    this.name = "SessionStoreReadError";
  }
}

export function classifySessionReadError(error: unknown): SessionReadFailureKind {
  const code = getErrnoCode(error);
  if (code === "ENOENT") {
    return "missing";
  }
  if (code !== undefined) {
    return "unreadable";
  }
  // JSON/schema/projection failures do not carry errno codes. Readers call this only around their
  // storage validation pipeline, so such failures represent corrupt persisted data.
  return "corrupt";
}

export function readFailure(error: unknown): SessionReadResult<never> {
  return { kind: classifySessionReadError(error), error };
}
