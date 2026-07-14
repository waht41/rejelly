/**
 * Error Classes Tests
 *
 * Tests for custom error classes and type guards
 */

import { describe, expect, it } from "vitest";
import {
  AbortError,
  AttemptsExhaustedError,
  BudgetExceededError,
  ContextNotFoundError,
  InvalidCostValueError,
  isAbortError,
  isAttemptsExhaustedError,
  isBudgetExceededError,
  isContextNotFoundError,
  isInvalidCostValueError,
  isMaxDepthExceededError,
  isModelNotFoundError,
  isNotSupportedError,
  isRequiresAgentContextError,
  isRestoreError,
  isToolLoopExceededError,
  isTurnBudgetExceededError,
  MaxDepthExceededError,
  ModelNotFoundError,
  ModelRegistryNotFoundError,
  NotSupportedError,
  RequiresAgentContextError,
  RestoreError,
  ToolLoopExceededError,
  TurnBudgetExceededError,
  toErrorInfo,
} from "../domain/errors";

describe("AttemptsExhaustedError", () => {
  it("has correct properties", () => {
    const error = new AttemptsExhaustedError({
      attempts: 2,
      issues: ["Field required", "Invalid type"],
      lastFailureType: "schema",
      lastData: { name: "test" },
      lastRawText: '{"name": 1}',
    });

    expect(error.name).toBe("AttemptsExhaustedError");
    expect(error.attempts).toBe(2);
    expect(error.issues).toEqual(["Field required", "Invalid type"]);
    expect(error.lastFailureType).toBe("schema");
    expect(error.lastData).toEqual({ name: "test" });
    expect(error.lastRawText).toBe('{"name": 1}');
    expect(error.message).toContain("All attempts exhausted");
    expect(error.message).toContain("2 attempts");
  });

  it("is instanceof Error", () => {
    const error = new AttemptsExhaustedError({
      attempts: 1,
      issues: [],
      lastFailureType: null,
      lastData: null,
      lastRawText: "",
    });
    expect(error).toBeInstanceOf(Error);
  });
});

describe("RestoreError", () => {
  it("has correct properties", () => {
    const error = new RestoreError("Restore failed: Trace is empty.");

    expect(error.name).toBe("RestoreError");
    expect(error.message).toBe("Restore failed: Trace is empty.");
  });

  it("is instanceof Error", () => {
    const error = new RestoreError("test");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("AbortError", () => {
  it("has correct properties with string reason", () => {
    const error = new AbortError("User cancelled");

    expect(error.name).toBe("AbortError");
    expect(error.reason).toBe("User cancelled");
    expect(error.message).toContain("User cancelled");
  });

  it("has correct properties with object reason", () => {
    const reason = { code: "TIMEOUT", message: "Request timeout" };
    const error = new AbortError(reason);

    expect(error.reason).toEqual(reason);
  });

  it("handles no reason", () => {
    const error = new AbortError();

    expect(error.reason).toBeUndefined();
    expect(error.message).toContain("Operation aborted");
  });
});

describe("BudgetExceededError", () => {
  it("has correct properties for token limit", () => {
    const error = new BudgetExceededError({ kind: "tokens", current: 1100, limit: 1000 });

    expect(error.name).toBe("BudgetExceededError");
    expect(error.kind).toBe("tokens");
    expect(error.current).toBe(1100);
    expect(error.limit).toBe(1000);
    expect(error.message).toContain("1100");
    expect(error.message).toContain("limit 1000");
  });

  it("has correct properties for cost limit", () => {
    const error = new BudgetExceededError({
      kind: "cost",
      current: 50_000,
      limit: 10_000,
      costUnit: "micro_usd",
    });

    expect(error.kind).toBe("cost");
    expect(error.current).toBe(50_000);
    expect(error.limit).toBe(10_000);
    expect(error.costUnit).toBe("micro_usd");
    expect(error.message).toContain("micro_usd");
    expect(error.message).toContain("50000");
  });
});

describe("InvalidCostValueError", () => {
  it("not_number: message describes type mismatch", () => {
    const error = new InvalidCostValueError({
      billingUnit: "micro_usd",
      source: "Tool[x]",
      reason: "not_number",
      value: "1",
    });
    expect(error.name).toBe("InvalidCostValueError");
    expect(error.reason).toBe("not_number");
    expect(error.message).toContain("number");
    expect(error.value).toBe("1");
  });

  it("not_finite: message describes NaN or Infinity", () => {
    const error = new InvalidCostValueError({
      billingUnit: "micro_usd",
      source: "Model[y]",
      reason: "not_finite",
      value: NaN,
    });
    expect(error.reason).toBe("not_finite");
    expect(error.message).toContain("finite");
  });

  it("not_integer: message describes float vs integer billing", () => {
    const error = new InvalidCostValueError({
      billingUnit: "micro_usd",
      source: "Tool[z]",
      reason: "not_integer",
      value: 0.04,
    });
    expect(error.reason).toBe("not_integer");
    expect(error.message).toContain("integer");
    expect(error.message).toContain("micro_");
  });
});

describe("TurnBudgetExceededError", () => {
  it("has correct properties", () => {
    const error = new TurnBudgetExceededError(10, 12);

    expect(error.name).toBe("TurnBudgetExceededError");
    expect(error.maxTurnSteps).toBe(10);
    expect(error.actualTurns).toBe(12);
    expect(error.message).toContain("10");
  });

  it("defaults actualTurns to maxTurnSteps", () => {
    const error = new TurnBudgetExceededError(5);

    expect(error.actualTurns).toBe(5);
  });
});

describe("ToolLoopExceededError", () => {
  it("has correct properties", () => {
    const error = new ToolLoopExceededError(10);

    expect(error.name).toBe("ToolLoopExceededError");
    expect(error.maxTurnSteps).toBe(10);
    expect(error.message).toContain("10");
  });

  it("is independent from TurnBudgetExceededError (policy vocabulary, not a subtype)", () => {
    const error = new ToolLoopExceededError(10);

    expect(error).not.toBeInstanceOf(TurnBudgetExceededError);
  });
});

describe("ContextNotFoundError", () => {
  it("has correct properties", () => {
    const error = new ContextNotFoundError();

    expect(error.name).toBe("ContextNotFoundError");
    expect(error.message).toContain("context");
  });
});

describe("RequiresAgentContextError", () => {
  it("has correct properties", () => {
    const error = new RequiresAgentContextError("withCustomSpan");

    expect(error.name).toBe("RequiresAgentContextError");
    expect(error.apiName).toBe("withCustomSpan");
    expect(error.message).toContain("withCustomSpan");
    expect(error.message).toContain("agent context");
  });
});

describe("ModelNotFoundError", () => {
  it("has correct properties", () => {
    const error = new ModelNotFoundError("gpt-5");

    expect(error.name).toBe("ModelNotFoundError");
    expect(error.modelId).toBe("gpt-5");
    expect(error.message).toContain("gpt-5");
  });
});

describe("ModelRegistryNotFoundError", () => {
  it("has correct properties and message when registry is empty", () => {
    const error = new ModelRegistryNotFoundError("missing-id", "my_agent");

    expect(error.name).toBe("ModelRegistryNotFoundError");
    expect(error.modelId).toBe("missing-id");
    expect(error.agentId).toBe("my_agent");
    expect(error.registeredIds).toBeUndefined();
    expect(error.message).toContain("missing-id");
    expect(error.message).toContain("my_agent");
    expect(error.message).toContain("runWith");
  });

  it("includes registeredIds in message when provided", () => {
    const error = new ModelRegistryNotFoundError("x", "agent", ["a", "b"]);

    expect(error.registeredIds).toEqual(["a", "b"]);
    expect(error.message).toContain("Available ids");
    expect(error.message).toContain("'a'");
    expect(error.message).toContain("'b'");
  });
});

describe("MaxDepthExceededError", () => {
  it("has correct properties", () => {
    const error = new MaxDepthExceededError(100);

    expect(error.name).toBe("MaxDepthExceededError");
    expect(error.maxDepth).toBe(100);
    expect(error.message).toContain("100");
  });
});

describe("NotSupportedError", () => {
  it("has correct properties", () => {
    const error = new NotSupportedError("capability missing");

    expect(error.name).toBe("NotSupportedError");
    expect(error.message).toBe("capability missing");
  });
});

describe("type guards", () => {
  it("isAttemptsExhaustedError", () => {
    expect(
      isAttemptsExhaustedError(
        new AttemptsExhaustedError({
          attempts: 1,
          issues: [],
          lastFailureType: null,
          lastData: null,
          lastRawText: "",
        }),
      ),
    ).toBe(true);
    expect(isAttemptsExhaustedError(new Error("test"))).toBe(false);
    expect(isAttemptsExhaustedError(null)).toBe(false);
  });

  it("isAbortError", () => {
    expect(isAbortError(new AbortError("reason"))).toBe(true);
    expect(isAbortError(new Error("test"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });

  it("isBudgetExceededError", () => {
    expect(
      isBudgetExceededError(new BudgetExceededError({ kind: "tokens", current: 100, limit: 50 })),
    ).toBe(true);
    expect(isBudgetExceededError(new Error("test"))).toBe(false);
  });

  it("isInvalidCostValueError", () => {
    expect(
      isInvalidCostValueError(
        new InvalidCostValueError({
          billingUnit: "micro_usd",
          source: "Tool[t]",
          reason: "not_integer",
          value: 1.5,
        }),
      ),
    ).toBe(true);
    expect(isInvalidCostValueError(new Error("test"))).toBe(false);
  });

  it("isRestoreError", () => {
    expect(isRestoreError(new RestoreError("test"))).toBe(true);
    expect(isRestoreError(new Error("test"))).toBe(false);
    expect(isRestoreError(null)).toBe(false);
  });

  it("isToolLoopExceededError", () => {
    expect(isToolLoopExceededError(new ToolLoopExceededError(10))).toBe(true);
    expect(isToolLoopExceededError(new TurnBudgetExceededError(10))).toBe(false);
    expect(isToolLoopExceededError(new Error("test"))).toBe(false);
  });

  it("isTurnBudgetExceededError matches only the engine-level error", () => {
    expect(isTurnBudgetExceededError(new TurnBudgetExceededError(10))).toBe(true);
    expect(isTurnBudgetExceededError(new ToolLoopExceededError(10))).toBe(false);
    expect(isTurnBudgetExceededError(new Error("test"))).toBe(false);
  });

  it("isContextNotFoundError", () => {
    expect(isContextNotFoundError(new ContextNotFoundError())).toBe(true);
    expect(isContextNotFoundError(new Error("test"))).toBe(false);
  });

  it("isRequiresAgentContextError", () => {
    expect(isRequiresAgentContextError(new RequiresAgentContextError("withCustomSpan"))).toBe(true);
    expect(isRequiresAgentContextError(new Error("test"))).toBe(false);
  });

  it("isModelNotFoundError", () => {
    expect(isModelNotFoundError(new ModelNotFoundError("test"))).toBe(true);
    expect(isModelNotFoundError(new Error("test"))).toBe(false);
  });

  it("isMaxDepthExceededError", () => {
    expect(isMaxDepthExceededError(new MaxDepthExceededError(10))).toBe(true);
    expect(isMaxDepthExceededError(new Error("test"))).toBe(false);
  });

  it("isNotSupportedError", () => {
    expect(isNotSupportedError(new NotSupportedError("x"))).toBe(true);
    expect(isNotSupportedError(new Error("test"))).toBe(false);
  });
});

describe("toErrorInfo", () => {
  it("handles plain Error", () => {
    const info = toErrorInfo(new Error("boom"));

    expect(info.name).toBe("Error");
    expect(info.message).toBe("boom");
    expect(info.stack).toBeDefined();
    expect(info.details).toBeUndefined();
    expect(info.cause).toBeUndefined();
  });

  it("handles non-object throws (string)", () => {
    const info = toErrorInfo("something went wrong");

    expect(info.name).toBe("Error");
    expect(info.message).toBe("something went wrong");
  });

  it("handles null", () => {
    const info = toErrorInfo(null);

    expect(info.name).toBe("Error");
    expect(info.message).toBe("null");
  });

  it("extracts details from AttemptsExhaustedError", () => {
    const error = new AttemptsExhaustedError({
      attempts: 3,
      issues: ["Required", "Invalid type"],
      lastFailureType: "schema",
      lastData: { name: 42 },
      lastRawText: '{"name": 42}',
    });
    const info = toErrorInfo(error);

    expect(info.name).toBe("AttemptsExhaustedError");
    expect(info.details).toEqual({
      attempts: 3,
      issues: ["Required", "Invalid type"],
      lastFailureType: "schema",
      lastData: { name: 42 },
      lastRawText: '{"name": 42}',
    });
    expect(info.cause).toBeUndefined();
  });

  it("extracts details from BudgetExceededError", () => {
    const error = new BudgetExceededError({ kind: "tokens", current: 1500, limit: 1000 });
    const info = toErrorInfo(error);

    expect(info.details).toEqual({
      kind: "tokens",
      current: 1500,
      limit: 1000,
    });
  });

  it("extracts details from InvalidCostValueError", () => {
    const error = new InvalidCostValueError({
      billingUnit: "micro_usd",
      source: "Model[m]",
      reason: "not_integer",
      value: 0.5,
    });
    const info = toErrorInfo(error);

    expect(info.details).toEqual({
      billingUnit: "micro_usd",
      source: "Model[m]",
      reason: "not_integer",
      value: 0.5,
    });
  });

  it("extracts details from ToolLoopExceededError", () => {
    const error = new ToolLoopExceededError(10, 10);
    const info = toErrorInfo(error);

    expect(info.details).toEqual({
      maxTurnSteps: 10,
      actualTurns: 10,
    });
  });

  it("recursively serializes cause chain", () => {
    const root = new TypeError("bad value");
    const mid = new Error("parse failed");
    (mid as any).cause = root;
    const outer = new Error("request failed");
    (outer as any).cause = mid;

    const info = toErrorInfo(outer);

    expect(info.name).toBe("Error");
    expect(info.message).toBe("request failed");
    expect(info.cause).toBeDefined();
    expect(info.cause!.name).toBe("Error");
    expect(info.cause!.message).toBe("parse failed");
    expect(info.cause!.cause).toBeDefined();
    expect(info.cause!.cause!.name).toBe("TypeError");
    expect(info.cause!.cause!.message).toBe("bad value");
    expect(info.cause!.cause!.cause).toBeUndefined();
  });

  it("handles cause that is a non-Error value", () => {
    const error = new Error("wrapper");
    (error as any).cause = "underlying reason";

    const info = toErrorInfo(error);

    expect(info.cause).toEqual({
      name: "Error",
      message: "underlying reason",
    });
  });

  it("does not leak cause into details", () => {
    const error = new Error("outer");
    (error as any).cause = new Error("inner");

    const info = toErrorInfo(error);

    expect(info.details).toBeUndefined();
    expect(info.cause).toBeDefined();
  });

  it("handles circular cause reference without infinite loop", () => {
    const a = new Error("error A");
    const b = new Error("error B");
    (a as any).cause = b;
    (b as any).cause = a;

    const info = toErrorInfo(a);

    expect(info.message).toBe("error A");
    expect(info.cause!.message).toBe("error B");
    expect(info.cause!.cause).toEqual({
      name: "CircularReference",
      message: "[Circular Reference Detected]",
    });
  });

  it("handles self-referencing cause", () => {
    const error = new Error("self");
    (error as any).cause = error;

    const info = toErrorInfo(error);

    expect(info.message).toBe("self");
    expect(info.cause).toEqual({
      name: "CircularReference",
      message: "[Circular Reference Detected]",
    });
  });
});
