/**
 * Context & Abort System Tests
 *
 * Tests for context management and abort functionality
 */

import { describe, expect, it, vi } from "vitest";
import { schemas } from "../../testing/helpers";
import { ensureActive } from "../context/abort";
import { getCurrentContext, getCurrentContextSafe, runInContext } from "../context/accessor";
import { createAgentContext } from "../context/factory";
import { AbortError } from "../domain/errors";
import type { Message, ModelAdapter, ModelStreamOptions, StreamEvent } from "../domain/model";
import { createAgent } from "../engine/agent";
import { reborn } from "../engine/flow/reborn";
import { sleep } from "../facade/async";
import { equipInstruction } from "../facade/equip/equip";
import { equipMemory } from "../facade/equip/memory";
import { promptAgent } from "../policy/prompt-schema";

// Abortable mock model
function createAbortableMock(response: object, streamDelay = 10): ModelAdapter {
  return {
    id: "abortable-mock",
    async *stream(_messages: Message[], options?: ModelStreamOptions): AsyncGenerator<StreamEvent> {
      const { signal } = options ?? {};

      if (signal?.aborted) throw new AbortError("Already aborted");

      const text = JSON.stringify(response);
      for (const char of text) {
        if (signal?.aborted) throw new AbortError("Stream aborted");
        yield { type: "text", content: char };
        await new Promise((r) => setTimeout(r, streamDelay));
      }
    },
  };
}

describe("context creation", () => {
  it("creates AbortController on context creation", async () => {
    const { ctx, cleanup } = createAgentContext();

    expect(ctx.controller).toBeInstanceOf(AbortController);
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.signal.aborted).toBe(false);

    await cleanup();
  });
});

describe("injected external signal", () => {
  it("forwards external abort to context controller", async () => {
    const ac = new AbortController();
    const { ctx, cleanup } = createAgentContext({ signal: ac.signal });

    expect(ctx.signal.aborted).toBe(false);
    ac.abort("ext");
    expect(ctx.signal.aborted).toBe(true);

    await cleanup();
  });

  it("starts aborted if external signal already aborted", async () => {
    const ac = new AbortController();
    ac.abort("done");
    const { ctx, cleanup } = createAgentContext({ signal: ac.signal });

    expect(ctx.signal.aborted).toBe(true);

    await cleanup();
  });
});

describe("cascading abort", () => {
  it("parent abort cascades to child", async () => {
    const { ctx: parent, cleanup: parentCleanup } = createAgentContext();

    let childAborted = false;

    await runInContext(parent, async () => {
      const { ctx: child, cleanup: childCleanup } = createAgentContext();

      await runInContext(child, async () => {
        child.signal.addEventListener("abort", () => {
          childAborted = true;
        });
        parent.controller.abort("parent abort");

        expect(child.signal.aborted).toBe(true);
        expect(childAborted).toBe(true);
      });

      await childCleanup();
    });

    await parentCleanup();
  });

  it("child created after parent abort is immediately aborted", async () => {
    const { ctx: parent, cleanup: parentCleanup } = createAgentContext();

    parent.controller.abort("already aborted");

    await runInContext(parent, async () => {
      const { ctx: child, cleanup: childCleanup } = createAgentContext();

      expect(child.signal.aborted).toBe(true);

      await childCleanup();
    });

    await parentCleanup();
  });

  it("multi-level cascade works", async () => {
    const { ctx: grandparent, cleanup: gpCleanup } = createAgentContext();

    let parentAborted = false;
    let childAborted = false;

    await runInContext(grandparent, async () => {
      const { ctx: parent, cleanup: parentCleanup } = createAgentContext();

      await runInContext(parent, async () => {
        parent.signal.addEventListener("abort", () => {
          parentAborted = true;
        });

        const { ctx: child, cleanup: childCleanup } = createAgentContext();

        await runInContext(child, async () => {
          child.signal.addEventListener("abort", () => {
            childAborted = true;
          });

          grandparent.controller.abort("grandparent abort");

          expect(parent.signal.aborted).toBe(true);
          expect(child.signal.aborted).toBe(true);
          expect(parentAborted).toBe(true);
          expect(childAborted).toBe(true);
        });

        await childCleanup();
      });

      await parentCleanup();
    });

    await gpCleanup();
  });

  it("fans out one parent listener to many concurrent children", async () => {
    const { ctx: parent, cleanup: parentCleanup } = createAgentContext();
    const addListener = vi.spyOn(parent.signal, "addEventListener");
    const removeListener = vi.spyOn(parent.signal, "removeEventListener");

    const children: Array<ReturnType<typeof createAgentContext>> = [];
    await runInContext(parent, async () => {
      for (let index = 0; index < 12; index++) {
        children.push(createAgentContext());
      }
    });

    expect(addListener.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1);

    parent.controller.abort("fan out");
    expect(children.every(({ ctx }) => ctx.signal.aborted)).toBe(true);

    for (const { cleanup } of children) {
      await cleanup();
    }
    expect(removeListener).not.toHaveBeenCalled();
    await parentCleanup();
  });

  it("gives parallel prompted children independent model abort signals", async () => {
    const modelSignals = new Set<AbortSignal>();
    const mock: ModelAdapter = {
      id: "parallel-signal-mock",
      async *stream(_messages, options) {
        if (!options?.signal) {
          throw new Error("expected model signal");
        }
        modelSignals.add(options.signal);
        yield { type: "text", content: JSON.stringify({ done: true }) };
        yield { type: "finish", finishReason: "stop" };
      },
    };

    const child = createAgent({
      id: "parallel_signal_child",
      model: mock,
      handler: async () => promptAgent(schemas.done),
    });
    const parent = createAgent({
      id: "parallel_signal_parent",
      model: mock,
      handler: async () => Promise.all(Array.from({ length: 12 }, () => child({}))),
    });

    await parent({});

    expect(modelSignals.size).toBe(12);
  });
});

describe("cleanup", () => {
  it("cleanup removes parent listener (no leak)", async () => {
    const { ctx: parent, cleanup: parentCleanup } = createAgentContext();

    await runInContext(parent, async () => {
      const { ctx: child, cleanup: childCleanup } = createAgentContext();

      await childCleanup();

      // After cleanup, parent abort should not affect child
      let childAbortedAfter = false;
      child.signal.addEventListener("abort", () => {
        childAbortedAfter = true;
      });

      parent.controller.abort("after cleanup");

      expect(child.signal.aborted).toBe(false);
      expect(childAbortedAfter).toBe(false);
    });

    await parentCleanup();
  });
});

describe("ensureActive", () => {
  it("does not throw when not aborted", async () => {
    const { ctx, cleanup } = createAgentContext();

    await runInContext(ctx, async () => {
      expect(() => ensureActive()).not.toThrow();
    });

    await cleanup();
  });

  it("throws AbortError when aborted", async () => {
    const { ctx, cleanup } = createAgentContext();

    ctx.controller.abort("test abort");

    await runInContext(ctx, async () => {
      try {
        ensureActive();
        expect.fail("Should have thrown");
      } catch (e) {
        expect((e as Error).name).toBe("AbortError");
        expect((e as Error).message).toContain("test abort");
      }
    });

    await cleanup();
  });

  it("does not throw without context", () => {
    expect(() => ensureActive()).not.toThrow();
  });
});

describe("getCurrentContextSafe", () => {
  it("returns context when in context", async () => {
    const { ctx, cleanup } = createAgentContext();

    await runInContext(ctx, async () => {
      expect(getCurrentContextSafe()).toBe(ctx);
    });

    await cleanup();
  });

  it("returns undefined without context", () => {
    expect(getCurrentContextSafe()).toBeUndefined();
  });
});

describe("agent abort integration", () => {
  it("agent can be aborted externally", async () => {
    const slowMock = createAbortableMock({ result: "done" }, 100);

    let controller: AbortController | undefined;

    const agent = createAgent({
      id: "test",
      model: slowMock,
      handler: async () => {
        const ctx = getCurrentContext();
        controller = ctx.controller;
        equipInstruction("slow task");
        return promptAgent(schemas.simple);
      },
    });

    const start = Date.now();
    const promise = agent({});

    await sleep(50);
    controller!.abort("cancelled");

    await expect(promise).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("parent agent abort cancels child agent", async () => {
    const mock = createAbortableMock({ done: true }, 50);

    let parentController: AbortController | undefined;
    let childStarted = false;
    let childCompleted = false;

    const childAgent = createAgent({
      id: "child",
      model: mock,
      handler: async () => {
        const ctx = getCurrentContext();
        childStarted = true;
        // Use abortable wait with the context's signal
        await sleep(2000, { signal: ctx.signal });
        childCompleted = true;
        return { child: "done" };
      },
    });

    const parentAgent = createAgent({
      id: "parent",
      model: mock,
      handler: async () => {
        const ctx = getCurrentContext();
        parentController = ctx.controller;
        return childAgent({});
      },
    });

    const start = Date.now();
    const promise = parentAgent({});

    await sleep(100);
    expect(childStarted).toBe(true);

    parentController!.abort("parent cancelled");

    await expect(promise).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1000);
    expect(childCompleted).toBe(false);
  });

  it("ensureActive() in loop detects abort", async () => {
    const mock = createAbortableMock({ result: "ok" });

    let controller: AbortController | undefined;
    let iterations = 0;

    const agent = createAgent({
      id: "test",
      model: mock,
      handler: async () => {
        const ctx = getCurrentContext();
        controller = ctx.controller;

        for (let i = 0; i < 100; i++) {
          ensureActive();
          iterations++;
          await sleep(20);
        }

        return { iterations };
      },
    });

    const promise = agent({});

    await sleep(100);
    controller!.abort("stop loop");

    try {
      await promise;
      expect.fail("Should have thrown");
    } catch (e) {
      expect((e as Error).name).toBe("AbortError");
    }
    expect(iterations).toBeGreaterThan(0);
    expect(iterations).toBeLessThan(100);
  });

  it("reborn loop can be aborted", async () => {
    const mock = createAbortableMock({ shouldContinue: true });

    let controller: AbortController | undefined;
    let rebornCount = 0;

    const agent = createAgent({
      id: "test",
      model: mock,
      handler: async () => {
        const ctx = getCurrentContext();
        controller = ctx.controller;

        const [count, setCount] = equipMemory("count", 0);
        rebornCount = count;

        // Use abortable wait
        await sleep(100, { signal: ctx.signal });

        if (count < 50) {
          setCount(count + 1);
          return reborn();
        }

        return { finalCount: count };
      },
    });

    const start = Date.now();
    const promise = agent({});

    await sleep(500);
    controller!.abort("stop reborn");

    await expect(promise).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(rebornCount).toBeGreaterThan(0);
    expect(rebornCount).toBeLessThan(50);
  });
});

describe("AbortError reason", () => {
  it("captures string reason", async () => {
    const mock = createAbortableMock({ done: true }, 50);

    let controller: AbortController | undefined;
    let caughtReason: unknown = null;

    const agent = createAgent({
      id: "test",
      model: mock,
      handler: async () => {
        const ctx = getCurrentContext();
        controller = ctx.controller;

        try {
          await sleep(5000, { signal: ctx.signal });
          return { done: true };
        } catch (e) {
          // Capture the signal's reason
          caughtReason = ctx.signal.reason;
          throw e;
        }
      },
    });

    const promise = agent({});

    await sleep(50);
    controller!.abort("User clicked cancel");

    try {
      await promise;
      expect.fail("Should have thrown");
    } catch (e) {
      // The error might be wrapped, just verify we caught it
      expect(e).toBeDefined();
    }
    expect(caughtReason).toBe("User clicked cancel");
  });
});

describe("parallel agents isolation", () => {
  it("parallel agents have independent abort", async () => {
    const mock = createAbortableMock({ done: true }, 20);

    const controllers: (AbortController | undefined)[] = [undefined, undefined, undefined];
    const results: string[] = [];

    const testAgent = createAgent({
      id: "test",
      model: mock,
      handler: async (props: { id: number }) => {
        const ctx = getCurrentContext();
        controllers[props.id] = ctx.controller;

        // Use abortable wait so abort signal is respected
        await sleep(500, { signal: ctx.signal });
        results.push(`agent-${props.id}-completed`);
        return { id: props.id };
      },
    });

    const promises = [testAgent({ id: 0 }), testAgent({ id: 1 }), testAgent({ id: 2 })];

    await sleep(100);
    controllers[1]!.abort("cancel agent 1");

    const settled = await Promise.allSettled(promises);

    expect(settled[0].status).toBe("fulfilled");
    expect(settled[1].status).toBe("rejected");
    expect(settled[2].status).toBe("fulfilled");

    expect(results).toContain("agent-0-completed");
    expect(results).not.toContain("agent-1-completed");
    expect(results).toContain("agent-2-completed");
  });
});

describe("abort propagation with async combinators", () => {
  it("parent abort cancels all children (setTimeout / all / race / allSettled)", async () => {
    const mock = createAbortableMock({ done: true }, 20);
    let parentController: AbortController | undefined;
    const started: string[] = [];
    const completed: string[] = [];

    const childAgent = createAgent({
      id: "child_abort_modes",
      model: mock,
      handler: async (props: { mode: "timeout" | "all" | "race" | "allSettled" }) => {
        const ctx = getCurrentContext();
        started.push(props.mode);

        if (props.mode === "timeout") {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 2000);
            const onAbort = () => {
              clearTimeout(timer);
              reject(new AbortError("Timeout task aborted"));
            };
            if (ctx.signal.aborted) {
              onAbort();
              return;
            }
            ctx.signal.addEventListener("abort", onAbort, { once: true });
          });
        } else if (props.mode === "all") {
          await Promise.all([
            sleep(2000, { signal: ctx.signal }),
            sleep(2200, { signal: ctx.signal }),
          ]);
        } else if (props.mode === "race") {
          await Promise.race([
            sleep(2000, { signal: ctx.signal }),
            sleep(2500, { signal: ctx.signal }),
          ]);
        } else {
          await Promise.allSettled([
            sleep(2000, { signal: ctx.signal }),
            sleep(2300, { signal: ctx.signal }),
          ]);
          // allSettled itself resolves; ensure abort still surfaces for this child
          ensureActive(ctx);
        }

        completed.push(props.mode);
        return { mode: props.mode };
      },
    });

    const parentAgent = createAgent({
      id: "parent_abort_modes",
      model: mock,
      handler: async () => {
        const ctx = getCurrentContext();
        parentController = ctx.controller;
        return Promise.all([
          childAgent({ mode: "timeout" }),
          childAgent({ mode: "all" }),
          childAgent({ mode: "race" }),
          childAgent({ mode: "allSettled" }),
        ]);
      },
    });

    const promise = parentAgent({});
    await sleep(100);
    parentController!.abort("parent cancelled");

    await expect(promise).rejects.toThrow();
    expect(started.sort()).toEqual(["all", "allSettled", "race", "timeout"]);
    expect(completed).toEqual([]);
  });

  it("child abort can be caught by parent; sibling is unaffected", async () => {
    const mock = createAbortableMock({ done: true }, 20);
    const completed: string[] = [];
    const controllers: Record<string, AbortController | undefined> = {};

    const childAgent = createAgent({
      id: "child_isolation_target",
      model: mock,
      handler: async (props: { name: "a" | "b"; durationMs: number }) => {
        const ctx = getCurrentContext();
        controllers[props.name] = ctx.controller;
        await sleep(props.durationMs, { signal: ctx.signal });
        completed.push(props.name);
        return props.name;
      },
    });

    const parentCatchingAgent = createAgent({
      id: "parent_catch_child_abort",
      model: mock,
      handler: async () => {
        const pa = childAgent({ name: "a", durationMs: 2000 });
        const pb = childAgent({ name: "b", durationMs: 120 });
        while (!controllers.a || !controllers.b) {
          await sleep(5);
        }
        controllers.a.abort("cancel child a");
        return Promise.allSettled([pa, pb]);
      },
    });

    const settled = await parentCatchingAgent({});
    expect(settled[0]?.status).toBe("rejected");
    expect(settled[1]?.status).toBe("fulfilled");
    expect(completed).toContain("b");
    expect(completed).not.toContain("a");
  });

  it("child abort pierces parent and cancels sibling when parent does not catch", async () => {
    const mock = createAbortableMock({ done: true }, 20);
    const completed: string[] = [];
    const controllers: Record<string, AbortController | undefined> = {};

    const childAgent = createAgent({
      id: "child_isolation_target_pierced",
      model: mock,
      handler: async (props: { name: "a" | "b"; durationMs: number }) => {
        const ctx = getCurrentContext();
        controllers[props.name] = ctx.controller;
        await sleep(props.durationMs, { signal: ctx.signal });
        completed.push(props.name);
        return props.name;
      },
    });

    const parentPiercedAgent = createAgent({
      id: "parent_pierced_by_child_abort",
      model: mock,
      handler: async () => {
        const pa = childAgent({ name: "a", durationMs: 2000 });
        // Silence potential unhandled rejection noise without blocking parent crash path.
        const pb = childAgent({ name: "b", durationMs: 2000 }).catch(() => undefined);

        while (!controllers.a || !controllers.b) {
          await sleep(5);
        }
        controllers.a.abort("cancel child a and pierce parent");
        await pa; // rethrow abort from child a, parent becomes failed/cancelled
        return pb;
      },
    });

    await expect(parentPiercedAgent({})).rejects.toThrow();
    expect(completed).not.toContain("b");
  });
});
