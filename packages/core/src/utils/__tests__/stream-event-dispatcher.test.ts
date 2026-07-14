import { describe, expect, it } from "vitest";
import { StreamEventDispatcher } from "../stream-event-dispatcher";

describe("StreamEventDispatcher", () => {
  it("replays existing events to a new subscriber", async () => {
    const dispatcher = new StreamEventDispatcher<string>();
    dispatcher.append("a");
    dispatcher.append("b");
    dispatcher.close();

    const received: string[] = [];
    for await (const event of dispatcher.subscribe()) {
      received.push(event);
    }

    expect(received).toEqual(["a", "b"]);
  });

  it("supports multicast with independent cursors", async () => {
    const dispatcher = new StreamEventDispatcher<string>();

    const reader1 = (async () => {
      const events: string[] = [];
      for await (const event of dispatcher.subscribe()) {
        events.push(event);
      }
      return events;
    })();

    dispatcher.append('{"step":1}');

    const reader2 = (async () => {
      const events: string[] = [];
      for await (const event of dispatcher.subscribe()) {
        events.push(event);
      }
      return events;
    })();

    dispatcher.append('{"step":2}');
    dispatcher.close();

    await expect(reader1).resolves.toEqual(['{"step":1}', '{"step":2}']);
    await expect(reader2).resolves.toEqual(['{"step":1}', '{"step":2}']);
  });

  it("can subscribe from a later cursor", async () => {
    const dispatcher = new StreamEventDispatcher<number>();
    dispatcher.append(1);
    dispatcher.append(2);
    dispatcher.append(3);
    dispatcher.close();

    const received: number[] = [];
    for await (const event of dispatcher.subscribe(1)) {
      received.push(event);
    }

    expect(received).toEqual([2, 3]);
  });

  it("wakes waiting subscribers when new events arrive", async () => {
    const dispatcher = new StreamEventDispatcher<string>();

    const reader = (async () => {
      const iterator = dispatcher.subscribe();
      const first = await iterator.next();
      const second = await iterator.next();
      const done = await iterator.next();
      return { first, second, done };
    })();

    dispatcher.append("x");
    dispatcher.append("y");
    dispatcher.close();

    await expect(reader).resolves.toEqual({
      first: { value: "x", done: false },
      second: { value: "y", done: false },
      done: { value: undefined, done: true },
    });
  });

  it("propagates close errors to subscribers", async () => {
    const dispatcher = new StreamEventDispatcher<string>();
    const error = new Error("stream failed");

    const reader = (async () => {
      const received: string[] = [];
      for await (const event of dispatcher.subscribe()) {
        received.push(event);
      }
      return received;
    })();

    dispatcher.append("before-error");
    dispatcher.close(error);

    await expect(reader).rejects.toBe(error);
  });

  it("rejects append after close", () => {
    const dispatcher = new StreamEventDispatcher<string>();
    dispatcher.close();

    expect(() => dispatcher.append("x")).toThrow("Cannot append to a closed StreamEventDispatcher");
  });

  it("stops a subscriber when its abort signal is triggered", async () => {
    const dispatcher = new StreamEventDispatcher<string>();
    const controller = new AbortController();

    const reader = (async () => {
      const received: string[] = [];
      for await (const event of dispatcher.subscribe(0, { signal: controller.signal })) {
        received.push(event);
      }
      return received;
    })();

    dispatcher.append("first");
    controller.abort("done");

    await expect(reader).resolves.toEqual(["first"]);
  });
});
