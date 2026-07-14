/**
 * Expect Resource Tests
 *
 * Tests for equipResource (with expose) and expectResource
 */

import { describe, expect, it } from "vitest";
import { createMockModel } from "../../testing/helpers";
import { ResourceNotFoundError } from "../domain/errors";
import { createAgent } from "../engine/agent";
import { reborn } from "../engine/flow/reborn";
import { equipMemory } from "../facade/equip/memory";
import { equipResource } from "../facade/equip/resource";
import { expectResource } from "../facade/expect/resource";
import { runWith } from "../facade/run";

// Mock resource types for testing
interface Database {
  query: (sql: string, params?: any[]) => Promise<any[]>;
  close: () => Promise<void>;
}

interface HttpClient {
  get: (url: string) => Promise<any>;
  close: () => Promise<void>;
}

describe("equipResource & expectResource", () => {
  describe("basic usage", () => {
    it("child agent can access resource from parent", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let receivedResource: Database | undefined;
      let queryCalled = false;

      const mockDb: Database = {
        query: async (_sql: string) => {
          queryCalled = true;
          return [{ id: 1, name: "test" }];
        },
        close: async () => {},
      };

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          receivedResource = expectResource<Database>("database");
          const result = await receivedResource.query("SELECT * FROM users");
          return { data: result };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          await equipResource("database", {
            create: async () => mockDb,
            destroy: async (db) => await db.close(),
            deps: [],
            expose: true, // Expose to children
          });
          return await ChildAgent({});
        },
      });

      const result = await ParentAgent({});

      expect(receivedResource).toBe(mockDb);
      expect(queryCalled).toBe(true);
      expect(result.data).toEqual([{ id: 1, name: "test" }]);
    });

    it("grandchild can access resource from grandparent", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let receivedResource: Database | undefined;

      const mockDb: Database = {
        query: async () => [{ id: 1 }],
        close: async () => {},
      };

      const GrandchildAgent = createAgent({
        id: "grandchild",
        model: mock.adapter,
        handler: async () => {
          receivedResource = expectResource<Database>("database");
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
          await equipResource("database", {
            create: async () => mockDb,
            destroy: async (db) => await db.close(),
            deps: [],
            expose: true,
          });
          return await ChildAgent({});
        },
      });

      await ParentAgent({});

      expect(receivedResource).toBe(mockDb);
    });

    it("can expose and access multiple resources", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let receivedDb: Database | undefined;
      let receivedHttp: HttpClient | undefined;

      const mockDb: Database = {
        query: async () => [],
        close: async () => {},
      };

      const mockHttp: HttpClient = {
        get: async () => ({ status: 200 }),
        close: async () => {},
      };

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          receivedDb = expectResource<Database>("database");
          receivedHttp = expectResource<HttpClient>("http_client");
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          await equipResource("database", {
            create: async () => mockDb,
            destroy: async (db) => await db.close(),
            deps: [],
            expose: true,
          });
          await equipResource("http_client", {
            create: async () => mockHttp,
            destroy: async (client) => await client.close(),
            deps: [],
            expose: true,
          });
          return await ChildAgent({});
        },
      });

      await ParentAgent({});

      expect(receivedDb).toBe(mockDb);
      expect(receivedHttp).toBe(mockHttp);
    });
  });

  describe("resource isolation", () => {
    it("non-exposed resource is not accessible to children", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const mockDb: Database = {
        query: async () => [],
        close: async () => {},
      };

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          // Try to access non-exposed resource
          expectResource<Database>("database");
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          // Create resource but don't expose it
          await equipResource("database", {
            create: async () => mockDb,
            destroy: async (db) => await db.close(),
            deps: [],
            expose: false, // Not exposed
          });
          return await ChildAgent({});
        },
      });

      await expect(ParentAgent({})).rejects.toThrow(ResourceNotFoundError);
      await expect(ParentAgent({})).rejects.toThrow("database");
    });

    it("siblings cannot see each other resources", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const mockDbA: Database = {
        query: async () => [],
        close: async () => {},
      };

      const mockDbB: Database = {
        query: async () => [],
        close: async () => {},
      };

      let siblingAResource: Database | undefined;
      let siblingBResource: Database | undefined;

      const SiblingA = createAgent({
        id: "sibling_a",
        model: mock.adapter,
        handler: async () => {
          await equipResource("database", {
            create: async () => mockDbA,
            destroy: async (db) => await db.close(),
            deps: [],
            expose: true,
          });
          siblingAResource = expectResource<Database>("database");
          return { done: true };
        },
      });

      const SiblingB = createAgent({
        id: "sibling_b",
        model: mock.adapter,
        handler: async () => {
          await equipResource("database", {
            create: async () => mockDbB,
            destroy: async (db) => await db.close(),
            deps: [],
            expose: true,
          });
          siblingBResource = expectResource<Database>("database");
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          await SiblingA({});
          await SiblingB({});
          return { done: true };
        },
      });

      await ParentAgent({});

      // Each sibling sees its own resource, not the other's
      expect(siblingAResource).toBe(mockDbA);
      expect(siblingBResource).toBe(mockDbB);
    });
  });

  describe("fail fast (ResourceNotFoundError)", () => {
    it("throws ResourceNotFoundError when resource not found", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          // Try to access non-existent resource
          expectResource("nonexistent");
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          // Don't create any resources
          return await ChildAgent({});
        },
      });

      await expect(ParentAgent({})).rejects.toThrow(ResourceNotFoundError);
      await expect(ParentAgent({})).rejects.toThrow("nonexistent");
    });

    it("ResourceNotFoundError includes helpful message", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          expectResource("missing_db");
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          return await ChildAgent({});
        },
      });

      try {
        await ParentAgent({});
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ResourceNotFoundError);
        const err = e as ResourceNotFoundError;
        expect(err.key).toBe("missing_db");
        expect(err.message).toContain("missing_db");
        expect(err.message).toContain("equipResource");
        expect(err.message).toContain("expose: true");
      }
    });

    it("returns undefined when resource not found and optional is true", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let receivedResource: Database | undefined;

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          // Try to access non-existent resource with optional flag
          receivedResource = expectResource<Database>("nonexistent", { optional: true });
          return { done: true, hasResource: receivedResource !== undefined };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          // Don't create any resources
          return await ChildAgent({});
        },
      });

      const result = await ParentAgent({});
      expect(receivedResource).toBeUndefined();
      expect(result.hasResource).toBe(false);
    });

    it("returns resource when found and optional is true", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let receivedResource: Database | undefined;

      const mockDb: Database = {
        query: async () => [],
        close: async () => {},
      };

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          // Access resource with optional flag (should still work when resource exists)
          receivedResource = expectResource<Database>("database", { optional: true });
          return { done: true, hasResource: receivedResource !== undefined };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          await equipResource("database", {
            create: async () => mockDb,
            destroy: async (db) => await db.close(),
            deps: [],
            expose: true,
          });
          return await ChildAgent({});
        },
      });

      const result = await ParentAgent({});
      expect(receivedResource).toBe(mockDb);
      expect(result.hasResource).toBe(true);
    });
  });

  describe("reborn behavior", () => {
    it("exposed resource persists across reborn", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let receivedResource: Database | undefined;
      let rebornCount = 0;

      const mockDb: Database = {
        query: async () => [],
        close: async () => {},
      };

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          receivedResource = expectResource<Database>("database");
          rebornCount++;
          if (rebornCount < 2) {
            return reborn();
          }
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          await equipResource("database", {
            create: async () => mockDb,
            destroy: async (db) => await db.close(),
            deps: [],
            expose: true,
          });
          return await ChildAgent({});
        },
      });

      await ParentAgent({});

      expect(rebornCount).toBe(2);
      expect(receivedResource).toBe(mockDb);
    });

    it("resource remains exposed after dependency change and rebuild", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let receivedResource: Database | undefined;
      const createdResources: Database[] = [];

      const createDb = (_id: string): Database => {
        const db: Database = {
          query: async () => [],
          close: async () => {},
        };
        createdResources.push(db);
        return db;
      };

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          receivedResource = expectResource<Database>("database");
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async (props: { dbId: string }) => {
          await equipResource("database", {
            create: async () => createDb(props.dbId),
            destroy: async (db) => await db.close(),
            deps: [props.dbId], // Dependency on dbId
            expose: true,
          });
          return await ChildAgent({});
        },
      });

      // First call with dbId='1'
      await ParentAgent({ dbId: "1" });
      const firstResource = receivedResource;
      expect(createdResources.length).toBe(1);

      // Second call with dbId='2' (different dependency)
      receivedResource = undefined;
      await ParentAgent({ dbId: "2" });
      const secondResource = receivedResource;
      expect(createdResources.length).toBe(2);
      expect(secondResource).not.toBe(firstResource);

      // Both resources should be accessible (different agent instances)
      expect(secondResource).toBe(createdResources[1]);
    });
  });

  describe("closest parent wins", () => {
    it("child sees closest parent resource when multiple parents expose same key", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let receivedResource: Database | undefined;

      const grandparentDb: Database = {
        query: async () => [],
        close: async () => {},
      };

      const parentDb: Database = {
        query: async () => [],
        close: async () => {},
      };

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          receivedResource = expectResource<Database>("database");
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          // Parent also exposes 'database'
          await equipResource("database", {
            create: async () => parentDb,
            destroy: async (db) => await db.close(),
            deps: [],
            expose: true,
          });
          return await ChildAgent({});
        },
      });

      const GrandparentAgent = createAgent({
        id: "grandparent",
        model: mock.adapter,
        handler: async () => {
          // Grandparent exposes 'database'
          await equipResource("database", {
            create: async () => grandparentDb,
            destroy: async (db) => await db.close(),
            deps: [],
            expose: true,
          });
          return await ParentAgent({});
        },
      });

      await GrandparentAgent({});

      // Child should see parent's resource (closest), not grandparent's
      expect(receivedResource).toBe(parentDb);
      expect(receivedResource).not.toBe(grandparentDb);
    });
  });

  describe("resource lifecycle", () => {
    it("destroy is called when resource is replaced", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const destroyCalls: string[] = [];
      let resourceId = 0;

      const createDb = (_id: string): Database => {
        const currentId = `db_${resourceId++}`;
        return {
          query: async () => [],
          close: async () => {
            destroyCalls.push(currentId);
          },
        };
      };

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async (props: { dbId: string }) => {
          await equipResource("database", {
            create: async () => createDb(props.dbId),
            destroy: async (db) => await db.close(),
            deps: [props.dbId],
            expose: true,
          });
          return { done: true };
        },
      });

      // First call - resource created, destroyed on teardown
      await ParentAgent({ dbId: "1" });
      const firstDestroyCount = destroyCalls.length;
      expect(firstDestroyCount).toBeGreaterThanOrEqual(0); // May be destroyed on teardown

      // Second call with different dependency - old resource should be destroyed
      const destroyCountBefore = destroyCalls.length;
      await ParentAgent({ dbId: "2" });
      const destroyCountAfter = destroyCalls.length;

      // When dependency changes, old resource should be destroyed
      // (plus teardown may destroy the new one)
      expect(destroyCountAfter).toBeGreaterThan(destroyCountBefore);
    });

    it("exposed resource is available even after reborn", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let receivedResource: Database | undefined;
      let accessCount = 0;

      const mockDb: Database = {
        query: async () => [],
        close: async () => {},
      };

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          receivedResource = expectResource<Database>("database");
          accessCount++;
          if (accessCount < 3) {
            return reborn();
          }
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          await equipResource("database", {
            create: async () => mockDb,
            destroy: async (db) => await db.close(),
            deps: [],
            expose: true,
          });
          return await ChildAgent({});
        },
      });

      await ParentAgent({});

      expect(accessCount).toBe(3);
      expect(receivedResource).toBe(mockDb);
    });
  });

  describe("optional destroy", () => {
    it("resource without destroy works and survives reborn", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let received: Database | undefined;
      let attempts = 0;

      // Borrowed/derived resource: no destroy provided.
      const mockDb: Database = {
        query: async () => [{ id: 1 }],
        close: async () => {
          throw new Error("close must never be called for a no-destroy resource");
        },
      };

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          received = expectResource<Database>("database");
          attempts++;
          if (attempts < 2) {
            return reborn();
          }
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          await equipResource("database", {
            create: async () => mockDb,
            // no destroy
            deps: [],
            expose: true,
          });
          return await ChildAgent({});
        },
      });

      await expect(ParentAgent({})).resolves.toEqual({ done: true });
      expect(attempts).toBe(2);
      expect(received).toBe(mockDb);
    });

    it("a resource can depend on another resource, both without destroy", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const mockPool = { id: "pool-1" };
      let repoSeenPool: unknown;

      const Agent = createAgent({
        id: "agent",
        model: mock.adapter,
        handler: async () => {
          // base resource (no destroy)
          const pool = await equipResource("pool", {
            create: async () => mockPool,
            deps: [],
          });
          // derived resource that depends on the base resource ref (no destroy)
          const repo = await equipResource<{ pool: unknown }>("repo", {
            create: async () => ({ pool }),
            deps: [pool],
          });
          repoSeenPool = repo.pool;
          return { done: true };
        },
      });

      await expect(Agent({})).resolves.toEqual({ done: true });
      // the derived resource captured the exact base resource instance
      expect(repoSeenPool).toBe(mockPool);
    });

    it("in-context deps change rebuilds a no-destroy resource without throwing, while a sibling with destroy is cleaned up", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const noDestroyCreates: number[] = [];
      const withDestroyDestroys: number[] = [];

      // Same context across reborn; deps derive from memory `gen`, which changes each
      // generation -> equipResource hits the cleanup-old branch in the SAME context.
      const Agent = createAgent({
        id: "agent",
        model: mock.adapter,
        handler: async () => {
          const [gen, setGen] = equipMemory("gen", 0);

          // no-destroy resource, keyed by gen
          await equipResource("cfg", {
            create: async () => {
              noDestroyCreates.push(gen);
              return { gen };
            },
            deps: [gen],
          });
          // sibling WITH destroy, keyed by gen — must be torn down on in-context rebuild
          await equipResource("conn", {
            create: async () => ({ gen }),
            destroy: async (c) => {
              withDestroyDestroys.push(c.gen);
            },
            deps: [gen],
          });

          if (gen < 2) {
            setGen(gen + 1);
            return reborn();
          }
          return { done: true };
        },
      });

      await expect(Agent({})).resolves.toEqual({ done: true });

      // created once per generation; no throw despite cfg having no destroy
      expect(noDestroyCreates).toEqual([0, 1, 2]);
      // old conn destroyed on each in-context rebuild (gen 0, then gen 1)
      expect(withDestroyDestroys).toContain(0);
      expect(withDestroyDestroys).toContain(1);
    });
  });

  describe("provider collision semantics", () => {
    it("expose:false does not delete a root-seeded provider in the same context", async () => {
      const rootPool = { id: "root" };
      const localPool = { id: "local" };

      const got = await runWith(
        async () => {
          await equipResource("db", {
            create: async () => localPool,
            deps: [],
            expose: false,
          });
          return expectResource<typeof rootPool>("db");
        },
        { providers: { db: rootPool } },
      );

      expect(got).toBe(rootPool);
    });

    it("fails fast when a root function exposes a resource over a root-seeded provider", async () => {
      const rootPool = { id: "root" };
      const localPool = { id: "local" };

      await expect(
        runWith(
          async () => {
            await equipResource("db", {
              create: async () => localPool,
              deps: [],
              expose: true,
            });
          },
          { providers: { db: rootPool } },
        ),
      ).rejects.toThrow(/provider binding/);
    });

    it("allows a child context to shadow a parent provider without modifying the parent", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const rootPool = { id: "root" };
      const childPool = { id: "child" };
      let seenInChild: unknown;

      const ChildAgent = createAgent({
        id: "child-shadow",
        model: mock.adapter,
        handler: async () => {
          await equipResource("db", {
            create: async () => childPool,
            deps: [],
            expose: true,
          });
          seenInChild = expectResource("db");
          return { done: true };
        },
      });

      const seenInRoot = await runWith(
        async () => {
          await ChildAgent({});
          return expectResource("db");
        },
        { providers: { db: rootPool } },
      );

      expect(seenInChild).toBe(childPool);
      expect(seenInRoot).toBe(rootPool);
    });

    it("rejects changing expose for an existing resource slot", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const Agent = createAgent({
        id: "expose-stability",
        model: mock.adapter,
        handler: async () => {
          await equipResource("db", {
            create: async () => ({ id: "local" }),
            deps: [],
            expose: false,
          });
          await equipResource("db", {
            create: async () => ({ id: "local" }),
            deps: [],
            expose: true,
          });
          return { done: true };
        },
      });

      await expect(Agent({})).rejects.toThrow(/expose:true/);
    });

    it("updates its own exposed provider binding when deps recreate the resource", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const Agent = createAgent({
        id: "exposed-recreate",
        model: mock.adapter,
        handler: async () => {
          await equipResource("db", {
            create: async () => ({ id: "first" }),
            deps: ["first"],
            expose: true,
          });
          const first = expectResource<{ id: string }>("db");

          await equipResource("db", {
            create: async () => ({ id: "second" }),
            deps: ["second"],
            expose: true,
          });
          const second = expectResource<{ id: string }>("db");

          return { first, second };
        },
      });

      const result = await Agent({});

      expect(result.first).toEqual({ id: "first" });
      expect(result.second).toEqual({ id: "second" });
    });
  });

  describe("type safety", () => {
    it("supports TypeScript generic type inference", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const mockDb: Database = {
        query: async () => [],
        close: async () => {},
      };

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          // TypeScript should infer Database type
          const db = expectResource<Database>("database");
          // TypeScript should know db has query method
          const result = await db.query("SELECT * FROM users");
          return { data: result };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          await equipResource("database", {
            create: async () => mockDb,
            destroy: async (db) => await db.close(),
            deps: [],
            expose: true,
          });
          return await ChildAgent({});
        },
      });

      const result = await ParentAgent({});
      expect(result.data).toEqual([]);
    });
  });
});
