import { describe, expect, it } from "vitest";
import { createDeferred } from "../deferred";

describe("createDeferred", () => {
  it("resolves later", async () => {
    const deferred = createDeferred<number>();

    expect(deferred.settled).toBe(false);

    deferred.resolve(42);

    await expect(deferred.promise).resolves.toBe(42);
    expect(deferred.settled).toBe(true);
  });

  it("rejects later", async () => {
    const deferred = createDeferred<number>();
    const error = new Error("boom");

    deferred.reject(error);

    await expect(deferred.promise).rejects.toBe(error);
    expect(deferred.settled).toBe(true);
  });

  it("ignores repeated settlement", async () => {
    const deferred = createDeferred<number>();

    deferred.resolve(1);
    deferred.reject(new Error("ignored"));
    deferred.resolve(2);

    await expect(deferred.promise).resolves.toBe(1);
    expect(deferred.settled).toBe(true);
  });
});
