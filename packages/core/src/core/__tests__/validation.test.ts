/**
 * Tests for LLM response cleaning before JSON parse / validation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMockModel } from "../../testing/helpers";
import { getCurrentContext } from "../context/accessor";
import { createAgentContext } from "../context/factory";
import { EVENTS, type TraceEvent } from "../domain/events";
import type { JsonSchema } from "../domain/model";
import { createAgent } from "../engine/agent";
import { createJsonOutputParser, type OutputParser } from "../engine/parse";
import {
  _executeValidation,
  cleanLLMResponse,
  executeValidation,
  validatePartialSchema,
} from "../engine/validation";
import { type EventBus, getGlobalEventBus, resetEventBus } from "../observability/event-bus";
import { createAgentPolicy } from "../policy/prompt";

describe("_executeValidation", () => {
  it("classifies missing structured content as no_content", async () => {
    const { ctx, cleanup } = createAgentContext();
    try {
      const r = await _executeValidation(
        ctx,
        "Here is my answer in plain text.",
        createJsonOutputParser(z.object({ any: z.string() })),
      );
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.failure.type).toBe("no_content");
        expect(r.errors[0]).toMatch(/\[no_content\]/);
      }
    } finally {
      await cleanup();
    }
  });

  it("classifies malformed parser output as parse_error when a root brace exists", async () => {
    const { ctx, cleanup } = createAgentContext();
    try {
      const r = await _executeValidation(
        ctx,
        '{"a":',
        createJsonOutputParser(z.object({ a: z.string() })),
      );
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.failure.type).toBe("parse_error");
        expect(r.errors[0]).toMatch(/\[parse_error\]/);
      }
    } finally {
      await cleanup();
    }
  });
});

describe("executeValidation", () => {
  let events: TraceEvent[];
  let eventBus: EventBus;

  // executeValidation is policy-internal (runtime seal): route calls through a
  // minimal policy so they carry a live runtime.
  const validatePolicy = createAgentPolicy({
    policyId: "test-execute-validation",
    handler: async (promptCtx, rawText: string, parser?: OutputParser) =>
      executeValidation(rawText, { runtime: promptCtx, parser }),
  });

  beforeEach(() => {
    resetEventBus();
    eventBus = getGlobalEventBus();
    events = [];
    eventBus.subscribe("*", (event) => {
      events.push(event);
    });
  });

  afterEach(() => {
    resetEventBus();
  });

  it("uses parser from options when provided", async () => {
    const agent = createAgent({
      id: "execute_validation_with_parser",
      model: createMockModel().adapter,
      handler: async () =>
        validatePolicy('{"value":"ok"}', createJsonOutputParser(z.object({ value: z.string() }))),
    });

    const result = await agent({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ value: "ok" });
    }

    const validationSuccess = events.find((event) => event.type === EVENTS.VALIDATION_SUCCESS);
    expect(validationSuccess).toBeDefined();
    expect(
      validationSuccess && "parserId" in validationSuccess ? validationSuccess.parserId : null,
    ).toBe("json");
  });

  it("returns rawText when parser is omitted", async () => {
    const agent = createAgent({
      id: "execute_validation_raw_text",
      model: createMockModel().adapter,
      handler: async () => validatePolicy("plain text"),
    });

    const result = await agent({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("plain text");
    }

    const validationSuccess = events.find((event) => event.type === EVENTS.VALIDATION_SUCCESS);
    expect(validationSuccess).toBeDefined();
    expect(
      validationSuccess && "parserId" in validationSuccess ? validationSuccess.parserId : null,
    ).toBe("rawText");
  });

  it("still runs validators when parser is omitted", async () => {
    const agent = createAgent({
      id: "execute_validation_raw_text_with_validator",
      model: createMockModel().adapter,
      handler: async () => {
        getCurrentContext().draft.validators.push({
          validator: (data) => (data === "plain text" ? "raw text is rejected" : true),
        });
        return validatePolicy("plain text");
      },
    });

    const result = await agent({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failure.type).toBe("validator");
      expect(result.errors).toEqual(["raw text is rejected"]);
      expect(result.data).toBe("plain text");
    }

    const validationFail = events.find((event) => event.type === EVENTS.VALIDATION_FAIL);
    expect(validationFail).toBeDefined();
    expect(validationFail && "parserId" in validationFail ? validationFail.parserId : null).toBe(
      "rawText",
    );
  });

  it("rejects bare handler calls (runtime seal) without flipping validationRan or emitting events", async () => {
    const bareExecuteValidation = executeValidation as unknown as (
      text: string,
    ) => Promise<unknown>;
    let validationRanAfterReject: boolean | undefined;
    const agent = createAgent({
      id: "execute_validation_bare",
      handler: async () => {
        const failure = await bareExecuteValidation("plain text").then(
          () => null,
          (error: unknown) => error,
        );
        // A bare call must not spoof the "validators never ran" bookkeeping.
        validationRanAfterReject = getCurrentContext().draft.validationRan;
        if (failure) throw failure;
      },
    });

    await expect(agent({})).rejects.toMatchObject({
      name: "InvalidPromptRuntimeError",
      apiName: "executeValidation",
      reason: "missing",
    });
    expect(validationRanAfterReject).toBeFalsy();
    expect(
      events.some(
        (event) =>
          event.type === EVENTS.VALIDATION_SUCCESS || event.type === EVENTS.VALIDATION_FAIL,
      ),
    ).toBe(false);
  });
});

describe("validatePartialSchema", () => {
  const answerSchema: JsonSchema = {
    type: "object",
    properties: {
      answer: { type: "string" },
      score: { type: "number" },
    },
    additionalProperties: false,
  };

  it("rejects object keys not declared in schema.properties (tool-chatter false positive)", () => {
    expect(validatePartialSchema({ query: "天气" }, answerSchema)).toBe(false);
  });

  it("accepts subset of schema keys", () => {
    expect(validatePartialSchema({ answer: "ok" }, answerSchema)).toBe(true);
    expect(validatePartialSchema({ answer: "ok", score: 1 }, answerSchema)).toBe(true);
  });

  it("accepts empty object during streaming", () => {
    expect(validatePartialSchema({}, answerSchema)).toBe(true);
  });

  it("skips key filter when additionalProperties is true", () => {
    const loose: JsonSchema = {
      type: "object",
      properties: { answer: { type: "string" } },
      additionalProperties: true,
    };
    expect(validatePartialSchema({ query: "x", answer: "y" }, loose)).toBe(true);
  });

  it("passes anyOf when one branch matches keys", () => {
    const s: JsonSchema = {
      anyOf: [
        { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
        { type: "object", properties: { b: { type: "number" } }, additionalProperties: false },
      ],
    };
    expect(validatePartialSchema({ a: "1" }, s)).toBe(true);
    expect(validatePartialSchema({ c: "x" }, s)).toBe(false);
  });
});

describe("cleanLLMResponse", () => {
  it("strips a single full-string fenced json block", () => {
    const raw = '```json\n{"x": 1}\n```';
    expect(cleanLLMResponse(raw)).toBe('{"x": 1}');
  });

  it("allows leading prose before a fenced json block", () => {
    const raw =
      "Now I have a complete understanding. Let me provide the structured analysis.\n\n" +
      "```json\n" +
      '{"analyzedFiles":["src/render-n.tsx"],"batchSummary":"ok"}\n' +
      "```";
    expect(cleanLLMResponse(raw)).toBe(
      '{"analyzedFiles":["src/render-n.tsx"],"batchSummary":"ok"}',
    );
    expect(JSON.parse(cleanLLMResponse(raw))).toEqual({
      analyzedFiles: ["src/render-n.tsx"],
      batchSummary: "ok",
    });
  });

  it("drops chatter before raw JSON object", () => {
    const raw = 'Here you go:\n{"a":true}';
    expect(cleanLLMResponse(raw)).toBe('{"a":true}');
  });

  it("drops chatter before raw JSON array", () => {
    const raw = "items:\n[1, 2]";
    expect(cleanLLMResponse(raw)).toBe("[1, 2]");
  });

  it("strips trailing fence when inner json is closed but fence is truncated", () => {
    const raw = '```json\n{"done":true}\n```';
    expect(cleanLLMResponse(raw)).toBe('{"done":true}');
  });

  it("handles fenced block without json language tag", () => {
    const raw = 'Note:\n```\n{"k":"v"}\n```';
    expect(cleanLLMResponse(raw)).toBe('{"k":"v"}');
  });

  it("does not end fenced JSON at markdown fences inside string values", () => {
    const jsonPart = '{"content":"before\\n```ts\\nconst x = 1;\\n```\\nafter","done":true}';
    const raw = `Note:\n\`\`\`json\n${jsonPart}\n\`\`\``;
    expect(cleanLLMResponse(raw)).toBe(jsonPart);
    expect(JSON.parse(cleanLLMResponse(raw))).toEqual({
      content: "before\n```ts\nconst x = 1;\n```\nafter",
      done: true,
    });
  });

  it("strips trailing XML content blocks after raw JSON", () => {
    const raw =
      '{"summary":"ok","detail":"@@T@@"}\n' +
      '<rejelly_placeholder id="@@T@@">\n# Title\n</rejelly_placeholder>\n';
    expect(cleanLLMResponse(raw)).toBe('{"summary":"ok","detail":"@@T@@"}');
  });

  it("strips trailing XML after fenced JSON", () => {
    const raw =
      "```json\n" +
      '{"a":1}\n' +
      "```\n" +
      '<rejelly_placeholder id="@@X@@">\nhi\n</rejelly_placeholder>';
    expect(cleanLLMResponse(raw)).toBe('{"a":1}');
  });

  it("raw JSON plus XML with embedded markdown fences still extracts the JSON object", () => {
    const raw =
      '{"title":"Batch","notes":"@@N@@"}\n' +
      '<rejelly_placeholder id="@@N@@">\n# Notes\n```ts\nconst x = 1\n```\n</rejelly_placeholder>';
    expect(cleanLLMResponse(raw)).toBe('{"title":"Batch","notes":"@@N@@"}');
  });

  it("stops at balanced JSON when XML tail contains many braces from code samples", () => {
    const jsonPart = '{"finalReport":"@@T@@"}';
    const xmlTail =
      '\n<rejelly_placeholder id="@@T@@">\n' +
      "createReconciler({HostConfig}) {staticOutput} {children}\n" +
      "function foo() { return {}; }\n" +
      "</rejelly_placeholder>";
    expect(cleanLLMResponse(jsonPart + xmlTail)).toBe(jsonPart);
  });

  it("does not treat closing braces inside JSON string values as object end", () => {
    const jsonPart = '{"msg":"He said } ok","x":1}';
    const raw = `${jsonPart}\n<rejelly_placeholder id="@@T@@">\nextra }\n</rejelly_placeholder>`;
    expect(cleanLLMResponse(raw)).toBe(jsonPart);
  });

  it("balances array roots when XML follows", () => {
    const raw = '[1,2]\n<rejelly_placeholder id="@@X@@">\n] }\n</rejelly_placeholder>';
    expect(cleanLLMResponse(raw)).toBe("[1,2]");
  });
});
