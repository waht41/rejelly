import {
  createAgent,
  type Message,
  type ModelAdapter,
  type ModelStreamOptions,
  promptChat,
  runWith,
  type StreamEvent,
} from "@rejelly/core";
import { describe, expect, it } from "vitest";
import { createSkillCatalog } from "../catalog/skillCatalog";
import type { SkillRecord } from "../definition/skillDefinition";
import { skillOrigin } from "../definition/skillDefinition";
import { equipSkillKit } from "./equipSkillKit";
import { SKILL_RUNTIME_PROVIDER_KEY, type SkillRuntimeSnapshot } from "./skillRuntime";

function record(): SkillRecord {
  return Object.freeze({
    name: "review",
    description: "Review the current change",
    origin: skillOrigin("project"),
    instruction: "Review carefully.",
    resources: Object.freeze([]),
  });
}

function snapshot(records: readonly SkillRecord[]): SkillRuntimeSnapshot {
  return Object.freeze({
    catalog: createSkillCatalog(records),
    access: Object.freeze({
      get: (skill: SkillRecord) =>
        Object.freeze({
          kind: "host-filesystem" as const,
          rootPath: `/skills/${skill.origin.scope}/${skill.name}`,
          mainResource: "SKILL.md" as const,
          pathConvention: "posix" as const,
        }),
    }),
    resources: Object.freeze({
      readText: async () => ({
        ok: false as const,
        reason: "resource-not-listed" as const,
        message: "not listed",
      }),
    }),
  });
}

function captureModel(
  calls: Array<{ messages: Message[]; tools: readonly string[] }>,
): ModelAdapter {
  return {
    id: "skill-kit-capture",
    stream: async function* (
      messages: Message[],
      options?: ModelStreamOptions,
    ): AsyncGenerator<StreamEvent> {
      calls.push({
        messages,
        tools: Object.freeze(options?.tools?.map((tool) => tool.name) ?? []),
      });
      yield { type: "text", content: "ok" };
    },
  };
}

function testAgent() {
  return createAgent({
    id: `skill_kit_test_${Math.random().toString(36).slice(2)}`,
    handler: async () => {
      equipSkillKit();
      return (await promptChat({ message: { role: "user", content: "hello" } })).data;
    },
  });
}

describe("equipSkillKit", () => {
  it("equips one catalog instruction and exactly three tools from the borrowed snapshot", async () => {
    const calls: Array<{ messages: Message[]; tools: readonly string[] }> = [];
    const agent = testAgent();

    await runWith(async () => agent({}), {
      model: captureModel(calls),
      providers: { [SKILL_RUNTIME_PROVIDER_KEY]: snapshot([record()]) },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools).toEqual(["read_skill", "list_skills", "read_skill_resource"]);
    const prompt = JSON.stringify(calls[0]?.messages);
    expect(prompt.match(/<available_skills>/g)).toHaveLength(1);
    expect(prompt).toContain("project:review");
  });

  it("adds no instruction or tools for an empty catalog", async () => {
    const calls: Array<{ messages: Message[]; tools: readonly string[] }> = [];

    await runWith(async () => testAgent()({}), {
      model: captureModel(calls),
      providers: { [SKILL_RUNTIME_PROVIDER_KEY]: snapshot([]) },
    });

    expect(calls[0]?.tools).toEqual([]);
    expect(JSON.stringify(calls[0]?.messages)).not.toContain("available_skills");
  });

  it("remains a no-op for hosts that do not provide a Skill snapshot", async () => {
    const calls: Array<{ messages: Message[]; tools: readonly string[] }> = [];

    await runWith(async () => testAgent()({}), { model: captureModel(calls) });

    expect(calls[0]?.tools).toEqual([]);
    expect(JSON.stringify(calls[0]?.messages)).not.toContain("available_skills");
  });
});
