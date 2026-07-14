/**
 * equipResource Tests
 *
 * Tests for resource lifecycle management (create/destroy)
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { captureWarnings, createMockModel } from "../../testing/helpers";
import { getCurrentContext } from "../context/accessor";
import { isAbortError } from "../domain/errors";
import { createAgent } from "../engine/agent";
import { reborn } from "../engine/flow/reborn";
import { equipResource } from "../facade/equip/resource";
import { promptAgent } from "../policy/prompt-schema";

describe("equipResource", () => {
  it("creates and caches resource when dependencies unchanged", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const create = vi.fn().mockResolvedValue({ connection: "db-conn-1" });
    const destroy = vi.fn().mockResolvedValue(undefined);

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        const res1 = await equipResource("db-conn", {
          create,
          destroy,
          deps: [1, 2],
        });
        const res2 = await equipResource("db-conn", {
          create,
          destroy,
          deps: [1, 2],
        });
        return { res1, res2 };
      },
    });

    const result = await agent({});

    // Create should only be called once
    expect(create).toHaveBeenCalledTimes(1);
    // Both results should be the same cached resource (deep equal, but different references due to cloning)
    expect(result.res1).toEqual({ connection: "db-conn-1" });
    expect(result.res2).toEqual({ connection: "db-conn-1" });
    expect(result.res1).toEqual(result.res2); // Deep equal, but different references

    // Destroy will be called during Agent teardown (expected behavior)
    // Wait a bit for teardown to complete
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys old resource and creates new when dependencies change", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const create = vi
      .fn()
      .mockResolvedValueOnce({ connection: "db-conn-1" })
      .mockResolvedValueOnce({ connection: "db-conn-2" });
    const destroy = vi.fn().mockResolvedValue(undefined);

    let callCount = 0;
    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        callCount++;
        const deps = callCount === 1 ? [1, 2] : [1, 3]; // Different deps on second call
        return await equipResource("db-conn", {
          create,
          destroy,
          deps,
        });
      },
    });

    const result1 = await agent({});
    const result2 = await agent({});

    // Create should be called twice
    expect(create).toHaveBeenCalledTimes(2);
    expect(result1).toEqual({ connection: "db-conn-1" });
    expect(result2).toEqual({ connection: "db-conn-2" });

    // Wait for teardown to complete
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Destroy should be called:
    // 1. When deps change (old resource cleanup)
    // 2. During Agent teardown (new resource cleanup)
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledWith({ connection: "db-conn-1" });
    expect(destroy).toHaveBeenCalledWith({ connection: "db-conn-2" });
  });

  it("preserves resource across reborn", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ continue: true });

    const create = vi.fn().mockResolvedValue({ connection: "db-conn-1" });
    const destroy = vi.fn().mockResolvedValue(undefined);

    let runCount = 0;
    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        runCount++;
        const resource = await equipResource("db-conn", {
          create,
          destroy,
          deps: [1, 2],
        });

        if (runCount < 2) {
          return reborn();
        }

        return { resource, runCount };
      },
    });

    const result = await agent({});

    // Create should only be called once (cached on reborn)
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.resource).toEqual({ connection: "db-conn-1" });
    expect(result.runCount).toBe(2);

    // Wait for teardown to complete
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Destroy will be called during Agent teardown (expected behavior)
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("handles destroy errors gracefully", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const create = vi
      .fn()
      .mockResolvedValueOnce({ connection: "db-conn-1" })
      .mockResolvedValueOnce({ connection: "db-conn-2" });
    const destroy = vi.fn().mockRejectedValue(new Error("Destroy failed"));

    const { warnings, restore } = captureWarnings();

    let callCount = 0;
    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        callCount++;
        const deps = callCount === 1 ? [1, 2] : [1, 3];
        return await equipResource("db-conn", {
          create,
          destroy,
          deps,
        });
      },
    });

    const result1 = await agent({});
    const result2 = await agent({});

    // Create should still be called for new resource
    expect(create).toHaveBeenCalledTimes(2);
    expect(result1).toEqual({ connection: "db-conn-1" });
    expect(result2).toEqual({ connection: "db-conn-2" });

    // Wait for teardown to complete
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Destroy should be called:
    // 1. When deps change (old resource cleanup - will fail)
    // 2. During Agent teardown (new resource cleanup)
    expect(destroy).toHaveBeenCalledTimes(2);
    // Warning should be logged
    expect(warnings.some((w) => w.includes("Failed to destroy resource"))).toBe(true);

    restore();
  });

  it("handles empty dependencies array", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const create = vi.fn().mockResolvedValue({ connection: "db-conn-1" });
    const destroy = vi.fn().mockResolvedValue(undefined);

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        const res1 = await equipResource("db-conn", {
          create,
          destroy,
          deps: [],
        });
        const res2 = await equipResource("db-conn", {
          create,
          destroy,
          deps: [],
        });
        return { res1, res2 };
      },
    });

    const result = await agent({});

    // Create should only be called once (empty deps are equal)
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.res1).toEqual(result.res2); // Deep equal, but different references

    // Wait for teardown to complete
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Destroy will be called during Agent teardown (expected behavior)
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("when second create throws after deps change, reborn does not double-destroy old resource", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const oldResource = { connection: "db-conn-1" };
    const newResource = { connection: "db-conn-2" };

    const create = vi
      .fn()
      .mockResolvedValueOnce(oldResource)
      .mockRejectedValueOnce(new Error("create failed (e.g. connection timeout)"))
      .mockResolvedValueOnce(newResource);

    const destroy = vi.fn().mockResolvedValue(undefined);

    let runCount = 0;
    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        runCount++;
        const deps = runCount === 1 ? [1, 2] : [1, 3];
        try {
          const resource = await equipResource("db-conn", {
            create,
            destroy,
            deps,
          });
          if (runCount < 3) return reborn();
          return { resource, runCount };
        } catch (err) {
          if (runCount === 2) return reborn();
          throw err;
        }
      },
    });

    const result = await agent({});

    // Run 1: deps [1,2], create -> R1, then reborn (reborn does NOT run teardown; destroy only on Agent end).
    // Run 2: deps [1,3], depsChanged -> destroy(R1), clear context, create throws; catch and reborn.
    // Run 3: deps [1,3], no old resource (cleared), create -> R2, return. Agent ends -> teardown -> destroy(R2).
    expect(create).toHaveBeenCalledTimes(3);
    expect(result.resource).toEqual(newResource);
    expect(result.runCount).toBe(3);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // destroy exactly twice: (1) deps change in run 2 destroyed R1; (2) Agent end teardown destroyed R2.
    // Without clearing context before create(), run 3 would still see R1 and destroy it again -> double-free.
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenNthCalledWith(1, oldResource);
    expect(destroy).toHaveBeenNthCalledWith(2, newResource);
  });
});

describe("Resource Teardown (LIFO destruction order)", () => {
  it("destroys resources in LIFO order on normal completion", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const destroyOrder: string[] = [];

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        await equipResource("res-A", {
          create: async () => ({ name: "A" }),
          destroy: async () => {
            destroyOrder.push("A");
          },
          deps: [],
        });
        await equipResource("res-B", {
          create: async () => ({ name: "B" }),
          destroy: async () => {
            destroyOrder.push("B");
          },
          deps: [],
        });
        return promptAgent(z.object({ result: z.string() }));
      },
    });

    await agent({});
    await new Promise((r) => setTimeout(r, 10));

    expect(destroyOrder).toEqual(["B", "A"]);
  });

  it("destroys resources in LIFO order when handler throws", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const destroyOrder: string[] = [];

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        await equipResource("res-A", {
          create: async () => ({ name: "A" }),
          destroy: async () => {
            destroyOrder.push("A");
          },
          deps: [],
        });
        await equipResource("res-B", {
          create: async () => ({ name: "B" }),
          destroy: async () => {
            destroyOrder.push("B");
          },
          deps: [],
        });

        throw new Error("Unexpected failure mid-execution");
      },
    });

    await expect(agent({})).rejects.toThrow("Unexpected failure mid-execution");
    await new Promise((r) => setTimeout(r, 10));

    expect(destroyOrder).toEqual(["B", "A"]);
  });

  it("destroys resources in LIFO order when AbortSignal is triggered", async () => {
    const mock = createMockModel();
    const destroyOrder: string[] = [];
    let agentController: AbortController | undefined;

    mock
      .when(() => true)
      .thenDo(async () => {
        // Abort while the model is "thinking"
        agentController!.abort("User cancelled");
        return { result: "ok" };
      });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        const ctx = getCurrentContext();
        agentController = ctx.controller;

        await equipResource("res-A", {
          create: async () => ({ name: "A" }),
          destroy: async () => {
            destroyOrder.push("A");
          },
          deps: [],
        });
        await equipResource("res-B", {
          create: async () => ({ name: "B" }),
          destroy: async () => {
            destroyOrder.push("B");
          },
          deps: [],
        });

        return promptAgent(z.object({ result: z.string() }));
      },
    });

    await expect(agent({})).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 10));

    expect(destroyOrder).toEqual(["B", "A"]);
  });

  it("continues cleanup when a destroy function throws (error isolation)", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const destroyOrder: string[] = [];
    const { restore } = captureWarnings();

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        await equipResource("res-A", {
          create: async () => ({ name: "A" }),
          destroy: async () => {
            destroyOrder.push("A");
          },
          deps: [],
        });
        await equipResource("res-B", {
          create: async () => ({ name: "B" }),
          destroy: async () => {
            destroyOrder.push("B");
            throw new Error("B destroy failed");
          },
          deps: [],
        });
        await equipResource("res-C", {
          create: async () => ({ name: "C" }),
          destroy: async () => {
            destroyOrder.push("C");
          },
          deps: [],
        });

        return promptAgent(z.object({ result: z.string() }));
      },
    });

    await agent({});
    await new Promise((r) => setTimeout(r, 10));

    // LIFO: C → B → A, B's error should not block A
    expect(destroyOrder).toEqual(["C", "B", "A"]);

    restore();
  });

  it("continues cleanup when destroy throws during error recovery", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const destroyOrder: string[] = [];
    const { restore } = captureWarnings();

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        await equipResource("res-A", {
          create: async () => ({ name: "A" }),
          destroy: async () => {
            destroyOrder.push("A");
          },
          deps: [],
        });
        await equipResource("res-B", {
          create: async () => ({ name: "B" }),
          destroy: async () => {
            destroyOrder.push("B");
            throw new Error("B destroy crashed");
          },
          deps: [],
        });
        await equipResource("res-C", {
          create: async () => ({ name: "C" }),
          destroy: async () => {
            destroyOrder.push("C");
          },
          deps: [],
        });

        throw new Error("Handler exploded");
      },
    });

    await expect(agent({})).rejects.toThrow("Handler exploded");
    await new Promise((r) => setTimeout(r, 10));

    // LIFO: C → B (error) → A, all still attempted
    expect(destroyOrder).toEqual(["C", "B", "A"]);

    restore();
  });

  // Regression coverage for INV-0004 / ISSUE-0009: the deps-change cleanup path and the
  // global teardown can interleave on the `await destroy(old)` / `await create()` cut points.
  describe("teardown interleaving (ISSUE-0009)", () => {
    it("destroys the old instance at most once when teardown races a deps change", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      // Hold the old instance's destroy in-flight so the deps-change path tries to destroy
      // the same instance the teardown snapshot is already destroying.
      let releaseDestroyA!: () => void;
      const destroyAGate = new Promise<void>((resolve) => {
        releaseDestroyA = resolve;
      });
      const destroy = vi.fn(async (res: { id: string }) => {
        if (res.id === "A") await destroyAGate;
      });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          const ctx = getCurrentContext();

          // gen 1 instance A: created + teardown-registered
          await equipResource("r", {
            create: async () => ({ id: "A" }),
            destroy,
            deps: [1],
          });

          // teardown snapshots A's destroyOnce and starts destroying it (parks on the gate)
          const teardownDone = ctx.teardown.execute();

          // deps change: would destroy A again (must dedup) and create B whose registration
          // now hits an already-executed teardown (must self-clean, not leak).
          const err = await equipResource("r", {
            create: async () => ({ id: "B" }),
            destroy,
            deps: [2],
          }).catch((e) => e);

          releaseDestroyA();
          await teardownDone;

          return { err, hasResource: ctx.resources?.active.has("r") ?? false };
        },
      });

      const result = await agent({});

      const aCalls = destroy.mock.calls.filter((c) => c[0].id === "A").length;
      const bCalls = destroy.mock.calls.filter((c) => c[0].id === "B").length;

      // Failure 1 fixed: old instance destroyed exactly once despite both paths firing.
      expect(aCalls).toBe(1);
      // Failure 2 fixed: new instance self-cleaned (not leaked) and generation aborted.
      expect(bCalls).toBe(1);
      expect(isAbortError(result.err)).toBe(true);
      expect(result.hasResource).toBe(false);
    });

    it("self-destroys (does not leak) a new instance created after teardown began", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let releaseCreate!: () => void;
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      const destroy = vi.fn(async () => {});

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          const ctx = getCurrentContext();

          // start a create that is still in-flight (parked on the gate); do not await
          const pending = equipResource("r", {
            create: async () => {
              await createGate;
              return { id: "B" };
            },
            destroy,
            deps: [1],
          }).catch((e) => e);

          // teardown runs while create() is pending — nothing is registered yet
          await ctx.teardown.execute();

          // create resolves AFTER teardown; registration must detect the executed state,
          // destroy the just-created instance, and abort instead of leaking it.
          releaseCreate();
          const err = await pending;

          return { err, hasResource: ctx.resources?.active.has("r") ?? false };
        },
      });

      const result = await agent({});

      expect(destroy).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledWith({ id: "B" });
      expect(isAbortError(result.err)).toBe(true);
      expect(result.hasResource).toBe(false);
    });
  });
});
