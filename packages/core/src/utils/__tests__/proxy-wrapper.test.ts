/**
 * createProxyWrapper Tests
 */

import { describe, expect, it } from "vitest";
import { createProxyWrapper } from "../proxy-wrapper";

describe("createProxyWrapper", () => {
  it("returns overridden properties", () => {
    const source = { id: "original", value: 42 };
    const wrapped = createProxyWrapper(source, { id: "overridden" });

    expect(wrapped.id).toBe("overridden");
    expect(wrapped.value).toBe(42);
  });

  it("falls back to source for non-overridden properties", () => {
    const source = { id: "original", custom: "value", count: 10 };
    const wrapped = createProxyWrapper(source, { id: "new-id" });

    expect(wrapped.id).toBe("new-id");
    expect(wrapped.custom).toBe("value");
    expect(wrapped.count).toBe(10);
  });

  describe("polymorphism (critical)", () => {
    it("source methods see overridden properties via this", () => {
      // This is the critical test case from the code review
      const source = {
        prefix: "Original",
        getName() {
          return `${this.prefix} Name`;
        },
      };

      const wrapped = createProxyWrapper(source, {
        prefix: "Wrapped",
      });

      expect(wrapped.prefix).toBe("Wrapped");
      // Key assertion: getName() should see the overridden prefix!
      expect(wrapped.getName()).toBe("Wrapped Name");
    });

    it("source methods see overridden id in ModelAdapter scenario", () => {
      const adapter = {
        id: "original",
        provider: "openai",
        getFullId() {
          return `${this.provider}:${this.id}`;
        },
      };

      const wrapped = createProxyWrapper(adapter, {
        id: "wrapped:original",
      });

      expect(wrapped.id).toBe("wrapped:original");
      // getFullId should see the overridden id
      expect(wrapped.getFullId()).toBe("openai:wrapped:original");
    });

    it("nested method calls go through proxy", () => {
      const source = {
        multiplier: 2,
        getValue() {
          return 10;
        },
        getMultiplied() {
          return this.getValue() * this.multiplier;
        },
      };

      const wrapped = createProxyWrapper(source, {
        multiplier: 5,
        getValue() {
          return 100;
        },
      });

      // Both getValue and multiplier should be overridden
      expect(wrapped.getMultiplied()).toBe(500); // 100 * 5
    });
  });

  describe("function reference identity", () => {
    it("maintains function identity across accesses", () => {
      const source = {
        method() {
          return "hello";
        },
      };

      const wrapped = createProxyWrapper(source, {});

      // Same reference on multiple accesses (no eager binding)
      expect(wrapped.method).toBe(wrapped.method);
    });

    it("maintains overridden function identity", () => {
      const source = { fn() {} };
      const overrideFn = () => "override";

      const wrapped = createProxyWrapper(source, { fn: overrideFn });

      expect(wrapped.fn).toBe(wrapped.fn);
    });
  });

  it("preserves prototype chain access with polymorphism", () => {
    class BaseAdapter {
      id = "base";

      greet() {
        return `Hello from ${this.id}`;
      }
    }

    const source = new BaseAdapter();
    const wrapped = createProxyWrapper(source, { id: "wrapped" });

    expect(wrapped.id).toBe("wrapped");
    // Method should see the overridden id (polymorphism)
    expect(wrapped.greet()).toBe("Hello from wrapped");
  });

  it("preserves this context for source methods", () => {
    const source = {
      name: "source",
      getName() {
        return this.name;
      },
    };

    const wrapped = createProxyWrapper(source, {});

    expect(wrapped.getName()).toBe("source");
  });

  it("preserves this context for overridden methods", () => {
    const source = { name: "source" };
    const wrapped = createProxyWrapper(source, {
      name: "wrapped",
      getName() {
        return (this as any).name;
      },
    });

    expect(wrapped.getName()).toBe("wrapped");
  });

  it('supports "in" operator', () => {
    const source = { original: true };
    const wrapped = createProxyWrapper(source, { override: true });

    expect("original" in wrapped).toBe(true);
    expect("override" in wrapped).toBe(true);
    expect("nonexistent" in wrapped).toBe(false);
  });

  it("supports Object.keys with combined keys", () => {
    const source = { a: 1, b: 2 };
    const wrapped = createProxyWrapper(source, { c: 3 });

    const keys = Object.keys(wrapped);
    expect(keys).toContain("a");
    expect(keys).toContain("b");
    expect(keys).toContain("c");
  });

  it("avoids duplicate keys in Object.keys", () => {
    const source = { id: "original", value: 1 };
    const wrapped = createProxyWrapper(source, { id: "overridden" });

    const keys = Object.keys(wrapped);
    const idCount = keys.filter((k) => k === "id").length;
    expect(idCount).toBe(1);
  });

  it("supports property assignment on overrides", () => {
    const source = { original: "source" };
    const overrides = { override: "initial" };
    const wrapped = createProxyWrapper(source, overrides);

    wrapped.override = "updated";

    expect(wrapped.override).toBe("updated");
    expect(overrides.override).toBe("updated");
  });

  it("supports property assignment on source", () => {
    const source = { original: "initial" };
    const wrapped = createProxyWrapper(source, {});

    wrapped.original = "updated";

    expect(wrapped.original).toBe("updated");
    expect(source.original).toBe("updated");
  });

  it("preserves getPrototypeOf", () => {
    class MyClass {
      method() {
        return "hello";
      }
    }

    const source = new MyClass();
    const wrapped = createProxyWrapper(source, {});

    expect(Object.getPrototypeOf(wrapped)).toBe(Object.getPrototypeOf(source));
  });

  it("works with async generator functions", async () => {
    const source = {
      async *stream() {
        yield "a";
        yield "b";
      },
    };

    const wrapped = createProxyWrapper(source, {
      async *stream() {
        yield "x";
        yield "y";
        yield "z";
      },
    });

    const results: string[] = [];
    for await (const item of wrapped.stream()) {
      results.push(item);
    }

    expect(results).toEqual(["x", "y", "z"]);
  });

  it("preserves non-overridden async generators", async () => {
    const source = {
      async *stream() {
        yield 1;
        yield 2;
      },
    };

    const wrapped = createProxyWrapper(source, { id: "wrapped" });

    const results: number[] = [];
    for await (const item of wrapped.stream()) {
      results.push(item);
    }

    expect(results).toEqual([1, 2]);
  });

  it("handles getters correctly with polymorphism", () => {
    const source = {
      _value: 10,
      multiplier: 2,
      get computed() {
        return this._value * this.multiplier;
      },
    };

    const wrapped = createProxyWrapper(source, { multiplier: 5 });

    // Getter should see overridden multiplier
    expect(wrapped.computed).toBe(50);
  });

  it("handles getters in overrides", () => {
    const source = { value: 10 };
    const wrapped = createProxyWrapper(source, {
      get doubled() {
        return (this as any).value * 2;
      },
    });

    expect(wrapped.doubled).toBe(20);
  });

  it("works with ModelAdapter-like objects", async () => {
    const originalAdapter = {
      id: "original-id",
      provider: "openai",
      getDescription() {
        return `${this.provider} adapter: ${this.id}`;
      },
      async *stream() {
        yield { type: "text", content: "original" };
      },
      calculateCost: (usage: any) => ({
        micro_usd: Math.round(usage.totalTokens * 0.001 * 1_000_000),
      }),
      modelVersion: "gpt-4",
      customConfig: { temperature: 0.7 },
    };

    const wrapped = createProxyWrapper(originalAdapter, {
      id: "wrapped:original-id",
      async *stream() {
        yield { type: "text", content: "wrapped" };
      },
    });

    // Standard properties should use wrapped values
    expect(wrapped.id).toBe("wrapped:original-id");
    expect(wrapped.provider).toBe("openai");

    // getDescription should see overridden id (polymorphism)
    expect(wrapped.getDescription()).toBe("openai adapter: wrapped:original-id");

    // Custom properties should be preserved from source
    expect((wrapped as any).modelVersion).toBe("gpt-4");
    expect((wrapped as any).customConfig).toEqual({ temperature: 0.7 });

    // Wrapped stream should work
    const events: any[] = [];
    for await (const event of wrapped.stream()) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "text", content: "wrapped" }]);

    // Original calculateCost should work
    expect(wrapped.calculateCost({ totalTokens: 1000 })).toEqual({ micro_usd: 1_000_000 });
  });

  it("handles inherited methods from complex prototype chains", () => {
    class GrandParent {
      name = "grandparent";
      grandMethod() {
        return `grand: ${this.name}`;
      }
    }

    class Parent extends GrandParent {
      parentMethod() {
        return `parent: ${this.name}`;
      }
    }

    class Child extends Parent {
      childMethod() {
        return `child: ${this.name}`;
      }
    }

    const source = new Child();
    const wrapped = createProxyWrapper(source, { name: "wrapped" });

    // All methods should see the overridden name
    expect(wrapped.childMethod()).toBe("child: wrapped");
    expect(wrapped.parentMethod()).toBe("parent: wrapped");
    expect(wrapped.grandMethod()).toBe("grand: wrapped");
  });

  it("calls overridden methods with correct this binding", () => {
    const source = {
      value: "source",
      getValue() {
        return this.value;
      },
    };

    const wrapped = createProxyWrapper(source, {
      value: "wrapped",
      getValue() {
        return (this as any).value;
      },
    });

    expect(wrapped.getValue()).toBe("wrapped");
  });

  describe("edge cases", () => {
    it("handles symbols as keys", () => {
      const sym = Symbol("test");
      const source = { [sym]: "source-value" };
      const wrapped = createProxyWrapper(source, {});

      expect(wrapped[sym]).toBe("source-value");
    });

    it("handles null and undefined values", () => {
      const source = { a: null, b: undefined };
      const wrapped = createProxyWrapper(source, { c: null });

      expect(wrapped.a).toBe(null);
      expect(wrapped.b).toBe(undefined);
      expect((wrapped as any).c).toBe(null);
    });

    it("overrides can be empty object", () => {
      const source = { id: "test", value: 42 };
      const wrapped = createProxyWrapper(source, {});

      expect(wrapped.id).toBe("test");
      expect(wrapped.value).toBe(42);
    });
  });
});
