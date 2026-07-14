/**
 * P0 regression probe — implicit-context isolation under concurrency.
 *
 * Background: notes/investigations/INV-0006 (production-agent capability coverage).
 * Rejelly's core selling point is implicit context (no explicit `ctx`): the equip / expect /
 * promptAgent facades read "the current agent instance" via the context accessor. That contract is
 * most fragile when
 * sibling agents run concurrently (Promise.all fan-out is the doc-sync / fan-in-fan-out shape, and
 * sibling-failure interleaving already produced a real bug — see ISSUE-0009 resource teardown).
 *
 * These tests deliberately interleave concurrent siblings at their `await` points and assert that
 * each one only ever sees ITS OWN draft / scope. They PASS when isolation holds and FAIL the moment
 * one sibling's implicit context bleeds into another. This is a guard, not a teaching example —
 * hence it lives in core's __tests__, not examples/.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMockModel } from "../../testing/helpers";
import { getCurrentContext } from "../context/accessor";
import { AbortError } from "../domain/errors";
import type { Message, ModelAdapter, ModelStreamOptions, StreamEvent } from "../domain/model";
import { createAgent } from "../engine/agent";
import { sleep } from "../facade/async";
import { equipInstruction, equipScope } from "../facade/equip/equip";
import { equipMemory } from "../facade/equip/memory";
import { equipResource } from "../facade/equip/resource";
import { expectScope } from "../facade/expect/scope";
import { promptAgent } from "../policy/prompt-schema";

const WORKER_COUNT = 8;
const ids = Array.from({ length: WORKER_COUNT }, (_, i) => `w${i}`);

/** Raw event-loop yield (no framework involvement) to maximize interleaving. */
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Staggered, deterministic jitter so equips cluster, then prompts/child-calls interleave. */
const jitterFor = (i: number) => (i % 4) * 3 + 1;

const EchoSchema = z.object({ seen: z.string() });
const ScopeSchema = z.object({ wid: z.string() });

/** Last user message text from the model's message list (matches mock extractPayload semantics). */
function lastUserText(messages: Message[]): string {
  const texts = messages
    .filter((m) => m.role === "user" && m.content != null)
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""),
    );
  return texts[texts.length - 1] ?? "";
}

/**
 * Signal-aware echo model: streams `{ seen: <last user message> }` char-by-char, checking the
 * abort signal between chunks. The slow stream keeps the model call suspended long enough that a
 * concurrent abort can land *inside* promptAgent (not just before/after it).
 */
function createEchoAbortableModel(streamDelay = 6): ModelAdapter {
  return {
    id: "echo-abortable-mock",
    async *stream(messages: Message[], options?: ModelStreamOptions): AsyncGenerator<StreamEvent> {
      const { signal } = options ?? {};
      if (signal?.aborted) throw new AbortError("Already aborted");
      const text = JSON.stringify({ seen: lastUserText(messages) });
      for (const char of text) {
        if (signal?.aborted) throw new AbortError("Stream aborted");
        yield { type: "text", content: char };
        await new Promise((resolve) => setTimeout(resolve, streamDelay));
      }
    },
  };
}

describe("P0: implicit-context isolation under concurrency (INV-0006)", () => {
  it("concurrent siblings keep an isolated draft (equipInstruction never bleeds into the model call)", async () => {
    // Model echoes back the last user message it actually received, so we can detect whether a
    // sibling's equipped instruction leaked into this worker's compiled prompt.
    const mock = createMockModel();
    mock.when(() => true).thenDo(async (p) => ({ seen: p.lastUserMessage ?? "" }));

    const Worker = createAgent<{ id: string; index: number }, { id: string; seen: string }>({
      id: "iso_worker_draft",
      model: mock.adapter,
      handler: async (props) => {
        equipInstruction(`instr:${props.id}`);
        // Yield AFTER equipping but BEFORE the prompt barrier: every sibling has now equipped its
        // own marker. A shared/module-level draft would pile all markers together here.
        await delay(jitterFor(props.index));
        const echoed = await promptAgent(EchoSchema);
        return { id: props.id, seen: echoed.seen };
      },
    });

    const Parent = createAgent<void, { id: string; seen: string }[]>({
      id: "iso_parent_draft",
      model: mock.adapter,
      handler: async () => Promise.all(ids.map((id, index) => Worker({ id, index }))),
    });

    const results = await Parent();

    expect(results).toHaveLength(WORKER_COUNT);
    for (const r of results) {
      // Must see its own marker...
      expect(r.seen).toContain(`instr:${r.id}`);
      // ...and NONE of its siblings'.
      for (const other of ids) {
        if (other === r.id) continue;
        expect(r.seen).not.toContain(`instr:${other}`);
      }
    }
  });

  it("concurrent siblings pass isolated scope down to their own grandchild", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    // Grandchild reads scope from the implicit context chain; under concurrency it must resolve to
    // ITS invoking worker, not a sibling that happened to be in-flight.
    const GrandChild = createAgent<void, { wid: string }>({
      id: "iso_grandchild_scope",
      model: mock.adapter,
      handler: async () => {
        const scope = expectScope(ScopeSchema);
        return { wid: scope.wid };
      },
    });

    const Worker = createAgent<{ id: string; index: number }, { id: string; wid: string }>({
      id: "iso_worker_scope",
      model: mock.adapter,
      handler: async (props) => {
        equipScope<{ wid: string }>({ wid: props.id });
        await delay(jitterFor(props.index)); // interleave before invoking the grandchild
        const seen = await GrandChild();
        return { id: props.id, wid: seen.wid };
      },
    });

    const Parent = createAgent<void, { id: string; wid: string }[]>({
      id: "iso_parent_scope",
      model: mock.adapter,
      handler: async () => Promise.all(ids.map((id, index) => Worker({ id, index }))),
    });

    const results = await Parent();

    expect(results).toHaveLength(WORKER_COUNT);
    for (const r of results) {
      expect(r.wid).toBe(r.id);
    }
  });

  it("a sibling failure does not corrupt the implicit context of in-flight survivors", async () => {
    // Ties to ISSUE-0009: one parallel branch rejecting must not perturb its siblings. We use
    // allSettled so survivors run to completion, then assert their drafts stayed isolated.
    const mock = createMockModel();
    mock.when(() => true).thenDo(async (p) => ({ seen: p.lastUserMessage ?? "" }));

    const failingId = ids[3];

    const Worker = createAgent<{ id: string; index: number }, { id: string; seen: string }>({
      id: "iso_worker_failure",
      model: mock.adapter,
      handler: async (props) => {
        equipInstruction(`instr:${props.id}`);
        await delay(jitterFor(props.index));
        if (props.id === failingId) {
          throw new Error(`boom:${props.id}`);
        }
        const echoed = await promptAgent(EchoSchema);
        return { id: props.id, seen: echoed.seen };
      },
    });

    const Parent = createAgent<void, PromiseSettledResult<{ id: string; seen: string }>[]>({
      id: "iso_parent_failure",
      model: mock.adapter,
      handler: async () => Promise.allSettled(ids.map((id, index) => Worker({ id, index }))),
    });

    const settled = await Parent();

    const failed = settled.filter((s) => s.status === "rejected");
    const fulfilled = settled.filter(
      (s): s is PromiseFulfilledResult<{ id: string; seen: string }> => s.status === "fulfilled",
    );

    expect(failed).toHaveLength(1);
    expect(fulfilled).toHaveLength(WORKER_COUNT - 1);

    for (const { value: r } of fulfilled) {
      expect(r.seen).toContain(`instr:${r.id}`);
      for (const other of ids) {
        if (other === r.id) continue;
        expect(r.seen).not.toContain(`instr:${other}`);
      }
    }
  });

  it("aborting one in-flight sibling mid-promptAgent leaves survivors' context isolated", async () => {
    // Distinct from the existing "parallel agents have independent abort" test (which only checks
    // completion status): here the abort lands while siblings are suspended inside promptAgent, and
    // we assert the torn-down sibling's equipped draft never bleeds into the survivors' model calls.
    const model = createEchoAbortableModel();
    const controllers: (AbortController | undefined)[] = ids.map(() => undefined);
    const abortIndex = 3;
    const abortedId = ids[abortIndex];

    const Worker = createAgent<{ id: string; index: number }, { id: string; seen: string }>({
      id: "iso_worker_abort",
      model,
      handler: async (props) => {
        // Capture this worker's own controller synchronously, before suspending in the model stream.
        controllers[props.index] = getCurrentContext().controller;
        equipInstruction(`instr:${props.id}`);
        const echoed = await promptAgent(EchoSchema);
        return { id: props.id, seen: echoed.seen };
      },
    });

    const Parent = createAgent<void, PromiseSettledResult<{ id: string; seen: string }>[]>({
      id: "iso_parent_abort",
      model,
      handler: async () => {
        const tasks = ids.map((id, index) => Worker({ id, index }));
        // All workers are now mid-stream; cancel exactly one of them.
        await sleep(20);
        controllers[abortIndex]?.abort("cancel one in-flight sibling");
        return Promise.allSettled(tasks);
      },
    });

    const settled = await Parent();

    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    const fulfilled = settled.filter(
      (s): s is PromiseFulfilledResult<{ id: string; seen: string }> => s.status === "fulfilled",
    );

    // Exactly the aborted worker rejects, with an AbortError.
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as Error).name).toBe("AbortError");
    expect(fulfilled).toHaveLength(WORKER_COUNT - 1);
    expect(fulfilled.map((s) => s.value.id)).not.toContain(abortedId);

    // Survivors each see ONLY their own instruction — including never seeing the aborted sibling's.
    for (const { value: r } of fulfilled) {
      expect(r.seen).toContain(`instr:${r.id}`);
      for (const other of ids) {
        if (other === r.id) continue;
        expect(r.seen).not.toContain(`instr:${other}`);
      }
    }
  });

  it("concurrent invocations of the same agent keep isolated equipMemory", async () => {
    // Router / fan-out shape: the SAME agent definition invoked many times in parallel. Each
    // invocation's memory must be its own — a shared store keyed only by "count" would let a
    // sibling's value satisfy this invocation's equipMemory and clobber its mutation.
    const model = createMockModel().adapter;
    const seedFor = (index: number) => (index + 1) * 100;

    const Worker = createAgent<
      { id: string; index: number },
      { id: string; initial: number; afterSet: number }
    >({
      id: "iso_worker_memory",
      model,
      handler: async (props) => {
        const seed = seedFor(props.index);
        const [initial, setCount] = equipMemory<number>("count", seed);
        // Yield so every sibling has equipped (and read) before anyone mutates.
        await delay(jitterFor(props.index));
        setCount(seed + 1);
        await delay(jitterFor(props.index));
        const [afterSet] = equipMemory<number>("count", -1);
        return { id: props.id, initial, afterSet };
      },
    });

    const Parent = createAgent<void, { id: string; initial: number; afterSet: number }[]>({
      id: "iso_parent_memory",
      model,
      handler: async () => Promise.all(ids.map((id, index) => Worker({ id, index }))),
    });

    const results = await Parent();

    expect(results).toHaveLength(WORKER_COUNT);
    for (const r of results) {
      const seed = seedFor(ids.indexOf(r.id));
      expect(r.initial).toBe(seed); // fresh per-invocation initial, never a sibling's value
      expect(r.afterSet).toBe(seed + 1); // own mutation survived, not clobbered by a sibling
    }
  });

  it("concurrent invocations of the same agent get an isolated equipResource (own instance, destroyed once)", async () => {
    // Complements ISSUE-0009 (which covered the within-context deps-change × teardown interleaving):
    // here the SAME resource key is created concurrently across sibling contexts. Each context must
    // get its own instance and destroy exactly it once — no cross-context sharing, no double-free,
    // no leak.
    const model = createMockModel().adapter;
    const seedFor = (index: number) => (index + 1) * 100;
    const created: number[] = [];
    const destroyed: number[] = [];

    const Worker = createAgent<{ id: string; index: number }, { id: string; resSeed: number }>({
      id: "iso_worker_resource",
      model,
      handler: async (props) => {
        const seed = seedFor(props.index);
        const res = await equipResource<{ seed: number }>("conn", {
          create: async () => {
            await delay(jitterFor(props.index)); // overlap concurrent creates of the same key
            created.push(seed);
            return { seed };
          },
          destroy: async (r) => {
            destroyed.push(r.seed);
          },
          deps: [],
        });
        await delay(jitterFor(props.index)); // hold it while siblings create theirs
        return { id: props.id, resSeed: res.seed };
      },
    });

    const Parent = createAgent<void, { id: string; resSeed: number }[]>({
      id: "iso_parent_resource",
      model,
      handler: async () => Promise.all(ids.map((id, index) => Worker({ id, index }))),
    });

    const results = await Parent();
    const expectedSeeds = ids.map((_, i) => seedFor(i)).sort((a, b) => a - b);
    const sortNum = (xs: number[]) => [...xs].sort((a, b) => a - b);

    // Each invocation saw its own instance, never a sibling's.
    for (const r of results) {
      expect(r.resSeed).toBe(seedFor(ids.indexOf(r.id)));
    }
    // Exactly one create per invocation — the key was not shared across sibling contexts.
    expect(sortNum(created)).toEqual(expectedSeeds);
    // Each instance destroyed exactly once when its own context tore down — no double-free, no leak.
    expect(sortNum(destroyed)).toEqual(expectedSeeds);
  });
});
