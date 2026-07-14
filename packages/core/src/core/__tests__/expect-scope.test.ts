/**
 * Context API Tests
 *
 * Tests for equipScope and expectScope
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMockModel } from "../../testing/helpers";
import { ExpectScopeError } from "../domain/errors";
import { createAgent } from "../engine/agent";
import { equipScope } from "../facade/equip/equip";
import { expectScope } from "../facade/expect/scope";

describe("equipScope & expectScope", () => {
  describe("basic usage", () => {
    it("child agent can read context from parent", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let receivedContext: any;

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          receivedContext = expectScope(
            z.object({
              userId: z.string(),
              debug: z.boolean(),
            }),
          );
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          equipScope({ userId: "u_123", debug: true });
          return await ChildAgent({});
        },
      });

      await ParentAgent({});

      expect(receivedContext.userId).toBe("u_123");
      expect(receivedContext.debug).toBe(true);
    });

    it("grandchild can see grandparent context", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let receivedContext: any;

      const GrandchildAgent = createAgent({
        id: "grandchild",
        model: mock.adapter,
        handler: async () => {
          receivedContext = expectScope(
            z.object({
              rootValue: z.string(),
            }),
          );
          return { done: true };
        },
      });

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          return await GrandchildAgent({});
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          equipScope({ rootValue: "from_root" });
          return await ChildAgent({});
        },
      });

      await ParentAgent({});

      expect(receivedContext.rootValue).toBe("from_root");
    });
  });

  describe("shadowing (key-level replacement)", () => {
    it("child layer shadows parent layer at key level", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let receivedContext: any;

      const GrandchildAgent = createAgent({
        id: "grandchild",
        model: mock.adapter,
        handler: async () => {
          receivedContext = expectScope(
            z.object({
              theme: z.string(),
              lang: z.string(),
            }),
          );
          return { done: true };
        },
      });

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          // Override only lang, theme should come from parent
          equipScope({ lang: "zh" });
          return await GrandchildAgent({});
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          equipScope({ theme: "dark", lang: "en" });
          return await ChildAgent({});
        },
      });

      await ParentAgent({});

      expect(receivedContext.theme).toBe("dark"); // From parent
      expect(receivedContext.lang).toBe("zh"); // Shadowed by child
    });

    it("undefined in child layer overwrites previous value", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let receivedContext: any;

      const GrandchildAgent = createAgent({
        id: "grandchild",
        model: mock.adapter,
        handler: async () => {
          receivedContext = expectScope(
            z.object({
              theme: z.string().optional(),
            }),
          );
          return { done: true };
        },
      });

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          // Explicitly set theme to undefined to clear parent value
          equipScope({ theme: undefined });
          return await GrandchildAgent({});
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          equipScope({ theme: "dark" });
          return await ChildAgent({});
        },
      });

      await ParentAgent({});

      expect(receivedContext.theme).toBeUndefined();
    });

    it("NO deep merge - entire object is replaced", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let receivedContext: any;

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          receivedContext = expectScope(
            z.object({
              config: z.object({
                a: z.number().optional(),
                b: z.number().optional(),
              }),
            }),
          );
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          // First provide { a: 1, b: 2 }
          equipScope({ config: { a: 1, b: 2 } });
          // Then override with { a: 10 } - should REPLACE, not merge
          equipScope({ config: { a: 10 } });
          return await ChildAgent({});
        },
      });

      await ParentAgent({});

      // NO deep merge: { a: 10 } replaces { a: 1, b: 2 }
      expect(receivedContext.config).toEqual({ a: 10 });
      expect(receivedContext.config.b).toBeUndefined();
    });
  });

  describe("sibling isolation", () => {
    it("siblings cannot see each other context", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let siblingAContext: any;
      let siblingBContext: any;

      const SiblingA = createAgent({
        id: "sibling_a",
        model: mock.adapter,
        handler: async () => {
          equipScope({ siblingAData: "from_a" });
          siblingAContext = expectScope(
            z.object({
              parentData: z.string(),
              siblingAData: z.string().optional(),
              siblingBData: z.string().optional(),
            }),
          );
          return { done: true };
        },
      });

      const SiblingB = createAgent({
        id: "sibling_b",
        model: mock.adapter,
        handler: async () => {
          equipScope({ siblingBData: "from_b" });
          siblingBContext = expectScope(
            z.object({
              parentData: z.string(),
              siblingAData: z.string().optional(),
              siblingBData: z.string().optional(),
            }),
          );
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          equipScope({ parentData: "from_parent" });
          // Run siblings sequentially
          await SiblingA({});
          await SiblingB({});
          return { done: true };
        },
      });

      await ParentAgent({});

      // Sibling A sees its own context + parent, not sibling B
      expect(siblingAContext.parentData).toBe("from_parent");
      expect(siblingAContext.siblingAData).toBe("from_a");
      expect(siblingAContext.siblingBData).toBeUndefined();

      // Sibling B sees its own context + parent, not sibling A
      expect(siblingBContext.parentData).toBe("from_parent");
      expect(siblingBContext.siblingBData).toBe("from_b");
      expect(siblingBContext.siblingAData).toBeUndefined();
    });
  });

  describe("fail fast (ScopeError)", () => {
    it("throws ScopeError for missing required field", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          // Expect requiredField but parent doesn't provide it
          expectScope(
            z.object({
              requiredField: z.string(),
            }),
          );
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          // Don't provide requiredField
          equipScope({ otherField: "value" });
          return await ChildAgent({});
        },
      });

      await expect(ParentAgent({})).rejects.toThrow(ExpectScopeError);
    });

    it("throws ScopeError for invalid type", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          expectScope(
            z.object({
              count: z.number(),
            }),
          );
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          // Provide string instead of number
          equipScope({ count: "not a number" });
          return await ChildAgent({});
        },
      });

      await expect(ParentAgent({})).rejects.toThrow(ExpectScopeError);
    });

    it("ScopeError includes zod error details", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          expectScope(
            z.object({
              userId: z.string(),
              settings: z.object({
                theme: z.enum(["light", "dark"]),
              }),
            }),
          );
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          equipScope({
            userId: 123, // Wrong type
            settings: { theme: "invalid" }, // Invalid enum value
          });
          return await ChildAgent({});
        },
      });

      try {
        await ParentAgent({});
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ExpectScopeError);
        const err = e as ExpectScopeError;
        expect(err.issues).toBeDefined();
        expect(err.issues!.length).toBeGreaterThan(0);
      }
    });
  });

  describe("deep readonly", () => {
    it("returned context is frozen (immutable)", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let receivedContext: any;

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          receivedContext = expectScope(
            z.object({
              user: z.object({
                name: z.string(),
              }),
            }),
          );
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          equipScope({ user: { name: "Alice" } });
          return await ChildAgent({});
        },
      });

      await ParentAgent({});

      // Verify object is frozen
      expect(Object.isFrozen(receivedContext)).toBe(true);
      expect(Object.isFrozen(receivedContext.user)).toBe(true);

      // Attempting to modify should throw in strict mode or be ignored
      expect(() => {
        receivedContext.user.name = "Bob";
      }).toThrow();
    });
  });

  describe("optional fields with defaults", () => {
    it("supports zod defaults for missing fields", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let receivedContext: any;

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          receivedContext = expectScope(
            z.object({
              debug: z.boolean().default(false),
              retries: z.number().default(3),
            }),
          );
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          // Don't provide debug or retries
          equipScope({});
          return await ChildAgent({});
        },
      });

      await ParentAgent({});

      expect(receivedContext.debug).toBe(false);
      expect(receivedContext.retries).toBe(3);
    });
  });

  describe("empty scope", () => {
    it("works with no scope layers", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let receivedContext: any;

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          // Empty schema - no requirements
          receivedContext = expectScope(
            z.object({
              optional: z.string().optional(),
            }),
          );
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          // No equipScope call
          return await ChildAgent({});
        },
      });

      await ParentAgent({});

      expect(receivedContext.optional).toBeUndefined();
    });
  });

  describe("plain value restriction", () => {
    it("throws TypeError for function values", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          // ❌ Function is forbidden
          // @ts-expect-error function not assignable to ScopeLayer
          equipScope({ handler: () => {} });
          return { done: true };
        },
      });

      await expect(ParentAgent({})).rejects.toThrow(TypeError);
      await expect(ParentAgent({})).rejects.toThrow("equipScope");
      await expect(ParentAgent({})).rejects.toThrow("function");
    });

    it("throws TypeError for symbol values", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          // ❌ Symbol is forbidden
          // @ts-expect-error symbol not assignable to ScopeLayer
          equipScope({ id: Symbol("id") });
          return { done: true };
        },
      });

      await expect(ParentAgent({})).rejects.toThrow(TypeError);
      await expect(ParentAgent({})).rejects.toThrow("symbol");
    });

    it("throws TypeError for class instances (Date)", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          // ❌ Date is a class instance
          // @ts-expect-error Date not assignable to ScopeLayer
          equipScope({ createdAt: new Date() });
          return { done: true };
        },
      });

      await expect(ParentAgent({})).rejects.toThrow(TypeError);
      await expect(ParentAgent({})).rejects.toThrow("class:Date");
    });

    it("throws TypeError for class instances (Map)", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          // ❌ Map is a class instance
          // @ts-expect-error Map not assignable to ScopeLayer
          equipScope({ cache: new Map() });
          return { done: true };
        },
      });

      await expect(ParentAgent({})).rejects.toThrow(TypeError);
      await expect(ParentAgent({})).rejects.toThrow("class:Map");
    });

    it("throws TypeError for nested invalid values", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          // ❌ Nested function is also forbidden
          // @ts-expect-error nested object with function not assignable to ScopeLayer
          equipScope({
            config: {
              valid: "value",
              nested: {
                callback: () => "bad",
              },
            },
          });
          return { done: true };
        },
      });

      await expect(ParentAgent({})).rejects.toThrow(TypeError);
      await expect(ParentAgent({})).rejects.toThrow("config.nested.callback");
    });

    it("throws TypeError for function in array", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          // ❌ Function in array is forbidden
          // @ts-expect-error function in array not assignable to ScopeLayer
          equipScope({
            handlers: [() => {}, () => {}],
          });
          return { done: true };
        },
      });

      await expect(ParentAgent({})).rejects.toThrow(TypeError);
      await expect(ParentAgent({})).rejects.toThrow("handlers[0]");
    });

    it("allows valid plain values", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let receivedContext: any;

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          receivedContext = expectScope(
            z.object({
              str: z.string(),
              num: z.number(),
              bool: z.boolean(),
              nil: z.null(),
              arr: z.array(z.number()),
              obj: z.object({ nested: z.string() }),
            }),
          );
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          // ✅ All these are valid plain values
          equipScope({
            str: "hello",
            num: 42,
            bool: true,
            nil: null,
            arr: [1, 2, 3],
            obj: { nested: "value" },
          });
          return await ChildAgent({});
        },
      });

      await ParentAgent({});

      expect(receivedContext.str).toBe("hello");
      expect(receivedContext.num).toBe(42);
      expect(receivedContext.bool).toBe(true);
      expect(receivedContext.nil).toBe(null);
      expect(receivedContext.arr).toEqual([1, 2, 3]);
      expect(receivedContext.obj).toEqual({ nested: "value" });
    });
  });
});
