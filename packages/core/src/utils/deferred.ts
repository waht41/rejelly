/**
 * Deferred promise primitive.
 *
 * Useful when a producer needs to wake async consumers later without polling.
 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  settled: boolean;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const deferred: Deferred<T> = {
    promise: new Promise<T>((innerResolve, innerReject) => {
      resolve = (value) => {
        if (deferred.settled) return;
        deferred.settled = true;
        innerResolve(value);
      };

      reject = (reason) => {
        if (deferred.settled) return;
        deferred.settled = true;
        innerReject(reason);
      };
    }),
    resolve: (value) => resolve(value),
    reject: (reason) => reject(reason),
    settled: false,
  };

  return deferred;
}
