/**
 * TeardownRegistry Tests
 *
 * Focused on tryRegister, the atomic "register-if-not-executed" used by
 * equipResource to avoid leaking resources created after teardown began
 * (see INV-0004 / ISSUE-0009).
 */

import { describe, expect, it, vi } from "vitest";
import { TeardownRegistry } from "../teardown";

describe("TeardownRegistry", () => {
  describe("tryRegister", () => {
    it("registers and runs the callback when teardown has not executed", async () => {
      const reg = new TeardownRegistry();
      const fn = vi.fn();

      const unregister = reg.tryRegister(fn);

      expect(typeof unregister).toBe("function");
      await reg.execute();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("unregister removes the callback so it never runs", async () => {
      const reg = new TeardownRegistry();
      const fn = vi.fn();

      const unregister = reg.tryRegister(fn);
      unregister?.();

      await reg.execute();
      expect(fn).not.toHaveBeenCalled();
    });

    it("returns null once teardown has executed", async () => {
      const reg = new TeardownRegistry();
      await reg.execute();

      expect(reg.tryRegister(vi.fn())).toBeNull();
    });
  });

  describe("register", () => {
    it("after execution returns a safe no-op and warns", async () => {
      const reg = new TeardownRegistry();
      await reg.execute();

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fn = vi.fn();

      const unregister = reg.register(fn);
      expect(typeof unregister).toBe("function");
      expect(() => unregister()).not.toThrow(); // no-op unregister is safe
      expect(fn).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();

      warn.mockRestore();
    });
  });

  describe("execute", () => {
    it("is idempotent: a second execute does not re-run callbacks", async () => {
      const reg = new TeardownRegistry();
      const fn = vi.fn();
      reg.tryRegister(fn);

      await reg.execute();
      await reg.execute();

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("runs callbacks in LIFO order", async () => {
      const reg = new TeardownRegistry();
      const order: string[] = [];
      reg.tryRegister(() => {
        order.push("A");
      });
      reg.tryRegister(() => {
        order.push("B");
      });

      await reg.execute();

      expect(order).toEqual(["B", "A"]);
    });
  });
});
