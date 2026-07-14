/**
 * Proxy Wrapper Utility
 *
 * Meta-programming helper for overlaying overrides on a source object.
 * Kept separate from object.ts to preserve generic object utils cohesion.
 */

/**
 * Create a proxy wrapper that overlays custom properties on top of a source object.
 *
 * Key features:
 * - Transparency: Forwards un-overridden props to source
 * - Polymorphism: Source methods will see overridden properties (correct `this` context)
 * - Stability: Preserves function identity (no eager binding)
 * - Prototype chain: All inherited properties and methods are accessible
 * - Type-honest: Returns `T & O` to reflect combined properties
 *
 * @param source - The original object to wrap
 * @param overrides - Properties to override or extend on the proxy
 * @returns A proxy that combines source with overrides (typed as T & O)
 *
 * @example
 * const adapter = {
 *   id: 'original',
 *   provider: 'openai',
 *   getFullId() { return `${this.provider}:${this.id}`; }
 * };
 * const wrapped = createProxyWrapper(adapter, { id: 'wrapped' });
 * wrapped.getFullId(); // 'openai:wrapped' (polymorphic)
 *
 * @note Private fields (`#field`) are not supported due to JS Proxy limitations.
 */
export function createProxyWrapper<T extends object, O extends object>(
  source: T,
  overrides: O,
): T & O {
  return new Proxy(source, {
    get(target, prop, receiver) {
      if (prop in overrides) {
        return Reflect.get(overrides, prop, receiver);
      }
      return Reflect.get(target, prop, receiver);
    },

    set(target, prop, value) {
      if (prop in overrides) {
        (overrides as Record<string | symbol, unknown>)[prop] = value;
        return true;
      }
      return Reflect.set(target, prop, value);
    },

    has(target, prop) {
      return prop in overrides || Reflect.has(target, prop);
    },

    ownKeys(target) {
      const sourceKeys = Reflect.ownKeys(target);
      const overrideKeys = Reflect.ownKeys(overrides);
      return Array.from(new Set([...sourceKeys, ...overrideKeys]));
    },

    getOwnPropertyDescriptor(target, prop) {
      if (prop in overrides) {
        const desc = Object.getOwnPropertyDescriptor(overrides, prop);
        if (desc) {
          desc.configurable = true;
          return desc;
        }
        return {
          value: (overrides as Record<string | symbol, unknown>)[prop],
          writable: true,
          enumerable: true,
          configurable: true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },

    getPrototypeOf(target) {
      return Reflect.getPrototypeOf(target);
    },
  }) as T & O;
}
