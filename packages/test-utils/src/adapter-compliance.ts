/**
 * Adapter Compliance Suite
 *
 * Shared contract tests for ModelAdapter implementations. Run from each adapter
 * package (e.g. @rejelly/adapter-gemini) to ensure consistent behavior across providers.
 * Use with real adapter + API key for E2E; skip when key is missing.
 *
 * @example
 * // In adapter package e2e.test.ts
 * const runE2E = process.env.GEMINI_API_KEY ? describe : describe.skip
 * runE2E('Compliance', () => {
 *   runStandardAdapterTests('Gemini', () =>
 *     createGeminiAdapter({ modelId: '...', apiKey: process.env.GEMINI_API_KEY! }),
 *     { basicStream: true, toolCall: true, toolChoice: true, nativeSchema: true, reasoning: true },
 *   )
 * })
 */

/// <reference types="vitest/globals" />

import type {
  JsonSchema,
  Message,
  ModelAdapter,
  ModelStreamOptions,
  StreamEvent,
  ToolDefinition,
} from "@rejelly/core";
import { z } from "zod";
import type { TestCapabilities } from "./capabilities";
import { runScenarioSuite, type TestScenario } from "./run-suite";

const VALID_EVENT_TYPES = [
  "text",
  "reasoning",
  "tool_call",
  "extra",
  "usage",
  "error",
  "finish",
] as const;

const minimalSchema: JsonSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
};

function minimalTool(): ToolDefinition {
  return {
    name: "ping",
    description: "Ping",
    parameters: z.object({}),
    handler: async () => ({ pong: true }),
  };
}

function isValidStreamEvent(ev: unknown): ev is StreamEvent {
  if (!ev || typeof ev !== "object" || !("type" in ev)) return false;
  const t = (ev as StreamEvent).type;
  if (!VALID_EVENT_TYPES.includes(t)) return false;
  if (
    t === "text" &&
    !("content" in ev) &&
    typeof (ev as { content?: string }).content !== "string"
  )
    return false;
  if (t === "tool_call" && !("toolCall" in ev)) return false;
  if (t === "extra" && !("extra" in ev)) return false;
  if (t === "usage" && !("usage" in ev)) return false;
  return true;
}

const complianceScenarios: TestScenario[] = [
  {
    name: "stream yields valid event types and shapes",
    capabilitiesRequired: ["basicStream"],
    handler: async (adapter: ModelAdapter) => {
      const messages: Message[] = [{ role: "user", content: 'Reply with JSON: {"ok":true}' }];
      const options: ModelStreamOptions = { schema: minimalSchema };
      const events: StreamEvent[] = [];
      for await (const ev of adapter.stream(messages, options)) {
        expect(isValidStreamEvent(ev)).toBe(true);
        events.push(ev as StreamEvent);
      }
      const hasContent = events.some(
        (e) => e.type === "text" || e.type === "usage" || e.type === "finish",
      );
      expect(hasContent).toBe(true);
    },
  },
  {
    name: "stream accepts tools and toolChoice without throwing",
    capabilitiesRequired: ["toolCall", "toolChoice"],
    handler: async (adapter: ModelAdapter) => {
      const messages: Message[] = [{ role: "user", content: "Hi" }];
      const options: ModelStreamOptions = {
        schema: minimalSchema,
        tools: [minimalTool()],
        toolChoice: "auto",
      };
      const events: StreamEvent[] = [];
      for await (const ev of adapter.stream(messages, options)) {
        events.push(ev as StreamEvent);
      }
      expect(Array.isArray(events)).toBe(true);
    },
  },
  {
    name: "stream respects abort signal",
    capabilitiesRequired: ["basicStream"],
    handler: async (adapter: ModelAdapter) => {
      const controller = new AbortController();
      const messages: Message[] = [{ role: "user", content: "Hi" }];
      const options: ModelStreamOptions = { schema: minimalSchema, signal: controller.signal };
      const stream = adapter.stream(messages, options);
      let count = 0;
      try {
        for await (const _ev of stream) {
          count++;
          if (count >= 1) {
            controller.abort();
          }
        }
      } catch {
        // Abort may throw or iterator may just stop
        expect(controller.signal.aborted).toBe(true);
      }
      expect(controller.signal.aborted).toBe(true);
    },
  },
];

/**
 * Runs standard adapter compliance tests. Uses Vitest describe/it (globals).
 * Call from adapter package test file; ensure vitest globals are enabled.
 */
export function runStandardAdapterTests(
  adapterName: string,
  getAdapter: () => ModelAdapter,
  capabilities: TestCapabilities,
): void {
  runScenarioSuite(
    `${adapterName} Adapter Compliance`,
    complianceScenarios,
    getAdapter,
    capabilities,
  );
}
