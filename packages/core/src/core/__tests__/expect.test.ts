/**
 * Expect Functions Tests
 *
 * Tests for promptAgent schema validation and expectValidator
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMockModel, schemas } from "../../testing/helpers";
import { createAgent } from "../engine/agent";
import { expectValidator } from "../facade/expect/expect";
import { promptAgent } from "../policy/prompt-schema";

describe("promptAgent schema validation", () => {
  describe("basic type validation", () => {
    it("validates string", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ name: "Alice" });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => promptAgent(z.object({ name: z.string() })),
      });

      const result = await agent({});
      expect(result.name).toBe("Alice");
    });

    it("validates number", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ age: 25, score: 98.5 });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () =>
          promptAgent(
            z.object({
              age: z.number().int(),
              score: z.number(),
            }),
          ),
      });

      const result = await agent({});
      expect(result.age).toBe(25);
      expect(result.score).toBe(98.5);
    });

    it("validates boolean", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ active: true, deleted: false });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () =>
          promptAgent(
            z.object({
              active: z.boolean(),
              deleted: z.boolean(),
            }),
          ),
      });

      const result = await agent({});
      expect(result.active).toBe(true);
      expect(result.deleted).toBe(false);
    });
  });

  describe("complex type validation", () => {
    it("validates enum", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ status: "pending" });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () =>
          promptAgent(
            z.object({
              status: z.enum(["pending", "completed"]),
            }),
          ),
      });

      const result = await agent({});
      expect(result.status).toBe("pending");
    });

    it("validates array", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ tags: ["a", "b", "c"] });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () =>
          promptAgent(
            z.object({
              tags: z.array(z.string()),
            }),
          ),
      });

      const result = await agent({});
      expect(result.tags).toEqual(["a", "b", "c"]);
    });

    it("validates nested object", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({
        user: { name: "Bob", profile: { age: 30 } },
      });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () =>
          promptAgent(
            z.object({
              user: z.object({
                name: z.string(),
                profile: z.object({ age: z.number() }),
              }),
            }),
          ),
      });

      const result = await agent({});
      expect(result.user.profile.age).toBe(30);
    });

    it("validates optional field", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ name: "Charlie" });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () =>
          promptAgent(
            z.object({
              name: z.string(),
              nickname: z.string().optional(),
            }),
          ),
      });

      const result = await agent({});
      expect(result.name).toBe("Charlie");
      expect(result.nickname).toBeUndefined();
    });

    it("applies default value", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ name: "David" });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () =>
          promptAgent(
            z.object({
              name: z.string(),
              role: z.string().default("user"),
            }),
          ),
      });

      const result = await agent({});
      expect(result.role).toBe("user");
    });

    it("validates union type", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: { type: "success", data: "ok" } });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () =>
          promptAgent(
            z.object({
              result: z.union([
                z.object({ type: z.literal("success"), data: z.string() }),
                z.object({ type: z.literal("error"), message: z.string() }),
              ]),
            }),
          ),
      });

      const result = await agent({});
      expect(result.result.type).toBe("success");
    });
  });

  describe("validation failure", () => {
    it("throws AttemptsExhaustedError on invalid data", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ name: 123 }); // wrong type

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        maxRetries: 0,
        handler: async () => promptAgent(z.object({ name: z.string() })),
      });

      const { AttemptsExhaustedError } = await import("../domain/errors");
      const err = await agent({}).catch((e) => e);
      expect(err).toBeInstanceOf(AttemptsExhaustedError);
      expect(err.attempts).toBe(1);
      expect(err.issues.length).toBeGreaterThan(0);
      expect(err.message).toContain("All attempts exhausted");
    });
  });
});

describe("expectValidator", () => {
  it("passes when validator returns true", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ age: 25 });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        expectValidator(z.object({ age: z.number() }), (d) => (d.age >= 0 ? true : "Age negative"));
        return promptAgent(z.object({ age: z.number() }));
      },
    });

    const result = await agent({});
    expect(result.age).toBe(25);
  });

  it("fails when validator returns string", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ age: -5 });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      maxRetries: 0,
      handler: async () => {
        expectValidator(z.object({ age: z.number() }), (d) =>
          d.age >= 0 ? true : "Age must be positive",
        );
        return promptAgent(z.object({ age: z.number() }));
      },
    });

    await expect(agent({})).rejects.toThrow("All attempts exhausted");
  });

  it("fails when validator returns false", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ value: "bad" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      maxRetries: 0,
      handler: async () => {
        expectValidator(() => false);
        return promptAgent(z.object({ value: z.string() }));
      },
    });

    await expect(agent({})).rejects.toThrow("All attempts exhausted");
  });

  it("multiple validators all run", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ name: "Alice", age: 25 });

    const v1 = vi.fn().mockReturnValue(true);
    const v2 = vi.fn().mockReturnValue(true);

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        expectValidator(v1);
        expectValidator(v2);
        return promptAgent(schemas.user);
      },
    });

    await agent({});

    expect(v1).toHaveBeenCalled();
    expect(v2).toHaveBeenCalled();
  });

  describe("overload 1: with schema for type inference", () => {
    it("passes when validator with schema returns true", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ name: "Alice", age: 25 });

      const UserSchema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          expectValidator(UserSchema, (data) => {
            // Type inference: data is { name: string; age: number }
            if (data.age < 0) return "Age cannot be negative";
            if (data.name.length < 2) return "Name too short";
            return true;
          });
          return promptAgent(UserSchema);
        },
      });

      const result = await agent({});
      expect(result.name).toBe("Alice");
      expect(result.age).toBe(25);
    });

    it("fails when validator with schema returns string", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ price: -10 });

      const PriceSchema = z.object({
        price: z.number(),
      });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        maxRetries: 0,
        handler: async () => {
          expectValidator(PriceSchema, (data) => {
            // Type inference: data is { price: number }
            if (data.price < 0) return "Price cannot be negative";
            return true;
          });
          return promptAgent(PriceSchema);
        },
      });

      await expect(agent({})).rejects.toThrow("All attempts exhausted");
    });

    it("works with complex schema and type inference", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({
        user: { name: "Bob", age: 30 },
        score: 95,
        tags: ["admin", "verified"],
      });

      const ComplexSchema = z.object({
        user: z.object({
          name: z.string(),
          age: z.number(),
        }),
        score: z.number(),
        tags: z.array(z.string()),
      });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          expectValidator(ComplexSchema, (data) => {
            // Type inference: full type safety for nested objects
            if (data.user.age < 18) return "User must be 18 or older";
            if (data.score < 0 || data.score > 100) return "Score must be 0-100";
            if (data.tags.length === 0) return "At least one tag required";
            return true;
          });
          return promptAgent(ComplexSchema);
        },
      });

      const result = await agent({});
      expect(result.user.name).toBe("Bob");
      expect(result.user.age).toBe(30);
      expect(result.score).toBe(95);
      expect(result.tags).toEqual(["admin", "verified"]);
    });
  });
});
